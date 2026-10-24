# Meta / Instagram setup

Phase 6 is implemented in code and covered by automated tests against a fake Graph API.
**A real connection and a real post have not been made yet**: that needs your Meta app,
an Instagram professional account, storage and the secrets below.

## Which API and why

**Instagram API with Instagram Login** (`graph.instagram.com`, API `v26.0`, checked against
Meta's documentation on 2026-10-24).

- Works with Instagram professional accounts (Business or Creator) **without** a linked Facebook Page.
- One login, one token per account, fewer permissions than the Facebook Login variant.
- Covers what phase 6 needs: profile, content publishing, publishing quota, webhooks.

The Facebook Login variant (`graph.facebook.com`, `instagram_basic`, `instagram_content_publish`,
`pages_read_engagement`) is not used.

## 1. Instagram account

- Switch the account to **Professional** (Business or Creator) in the Instagram app.
- For comment/mention webhooks the account must be **public**.

## 2. Meta app

1. developers.facebook.com → Create app → type **Business**.
2. Add the product **Instagram** → **API setup with Instagram login**.
3. Copy the **Instagram app ID** and **Instagram app secret** (shown on that page, not the Meta app's basic settings).
4. **Business login settings → OAuth redirect URIs**, add exactly:
   - `https://<your-domain>/api/v1/integrations/meta/callback`
   - for local testing with a tunnel: `https://<tunnel-host>/api/v1/integrations/meta/callback`
   The value must match `META_REDIRECT_URI` character for character.
5. **Deauthorize callback URL**: `https://<your-domain>/api/v1/webhooks/meta/deauthorize`
6. **Data deletion request URL**: `https://<your-domain>/api/v1/webhooks/meta/data-deletion`
7. Add yourself/testers under **App roles** while the app is in development mode.

### Permissions requested

| Permission | Used for | Required |
|---|---|---|
| `instagram_business_basic` | profile, account id, token refresh | yes (connection fails without it) |
| `instagram_business_content_publish` | creating and publishing posts | needed to publish; without it the account connects but "النشر غير متاح" |

Set via `META_INSTAGRAM_SCOPES` (default: both). Add `instagram_business_manage_comments` /
`instagram_business_manage_messages` only when the inbox (phase 7) uses them. Every permission
needs **App Review** before non-tester accounts can grant it.

## 3. Webhooks

1. In the Instagram product → **Webhooks**: callback `https://<your-domain>/api/v1/webhooks/meta`,
   verify token = the value of `META_WEBHOOK_VERIFY_TOKEN` (any long random string you choose).
2. Subscribe the fields you want (e.g. `comments`, `messages`).
3. Set `META_WEBHOOK_FIELDS=comments,messages`: each account is subscribed on connect via
   `POST graph.instagram.com/v26.0/<IG_ID>/subscribed_apps`.
4. Live notifications need the app in **Live** mode; `comments` needs Advanced Access.

How deliveries are handled:

- Signature: `X-Hub-Signature-256 = sha256=HMAC_SHA256(raw body, app secret)`, compared in constant time. Bad or missing signature → 401, nothing stored.
- Size limit 1 MB. Events are stored **before** 200 is returned; any storage failure returns 500 so Meta retries (Meta retries for up to 36 hours).
- Deduplication (Meta says this is our job and does not give every event an id):
  `messaging` → `message.mid`; `changes` with `value.id` (comments) → field + id; otherwise a SHA-256 of account + event time + field + value.
  **Limit:** two genuinely different events with identical time, field and value would be merged.
- Routing: by Instagram account id to the one organization with a live connection for it. Unknown accounts are stored but never processed.
- Processing: background worker, retries with backoff, `failed` after 5 attempts. Comment/message handlers arrive with the inbox (phase 7); until then events are kept and marked `ignored` with the reason.

## 4. Secrets

Tokens are encrypted with AES-256-GCM before they reach PostgreSQL (`integration_secrets`);
the organization id and secret ref are bound as authenticated data. The key is **not** in the database.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the output in `SECRETS_ENCRYPTION_KEY` in your host's secret manager (Vercel env vars, worker host secrets).
Web and worker need the **same** key. Rotation: set a new key with `SECRETS_KEY_VERSION=2` and keep the old one
in `SECRETS_PREVIOUS_KEYS=1:<old>`; tokens are re-encrypted with the new key when they are next refreshed.

For a managed KMS (AWS KMS, GCP KMS, HashiCorp Vault) implement the `SecretStore` interface in
`packages/integrations/src/secrets.ts`; nothing else needs to change. **Not done yet.**

## 5. Storage (required for publishing)

Instagram downloads the image from a URL itself, so it must be reachable from the internet.
Any S3-compatible bucket works (Cloudflare R2, AWS S3, Backblaze B2):

```dotenv
OBJECT_STORAGE_ENDPOINT=https://<account>.r2.cloudflarestorage.com
OBJECT_STORAGE_REGION=auto
OBJECT_STORAGE_BUCKET=dfos-media
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS=3600
```

- The bucket stays **private**. Meta gets a signed GET link valid for `OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS` (default 1 h; containers are processed within minutes). UI previews use 5-minute links.
- Endpoints on localhost / private IPs are refused for publishing (Meta cannot reach them).
- Uploads: JPEG only (Instagram's only supported image format), type detected from bytes, max `MEDIA_MAX_UPLOAD_BYTES` (8 MB), aspect ratio 4:5 – 1.91:1 checked before publishing, storage key is generated (never the file name). A media row is written only after the bucket confirms the object and its size.

## 6. Environment variables

| Variable | Where | Notes |
|---|---|---|
| `META_APP_ID` | web | Instagram app ID |
| `META_APP_SECRET` | web + worker | Instagram app secret (OAuth exchange, webhook signatures) |
| `META_REDIRECT_URI` | web | exact OAuth redirect URI |
| `META_WEBHOOK_VERIFY_TOKEN` | web | random string, same as in the app dashboard |
| `META_WEBHOOK_FIELDS` | web | optional, e.g. `comments,messages` |
| `META_GRAPH_API_VERSION` | web + worker | default `v26.0` |
| `META_INSTAGRAM_SCOPES` | web | default `instagram_business_basic,instagram_business_content_publish` |
| `SECRETS_ENCRYPTION_KEY` | web + worker | 32 bytes base64 |
| `OBJECT_STORAGE_*` | web + worker | see above |

## 7. Publishing flow and guarantees

1. User clicks **نشر الآن** (or the schedule time arrives).
2. Checked first, approval untouched if any fails: content approved, active + enabled connection of **this** org, `instagram_business_content_publish` granted, token not expired, JPEG attached, aspect ratio, storage reachable, caption ≤ 2200 chars, ≤ 30 hashtags.
3. Approval consumed (fingerprint of text + image hash + schedule + audience re-checked; approver rights re-checked; single use).
4. One `content_publications` row per approval (unique). Worker steps:
   `POST /<IG_ID>/media` (image_url, caption) → poll `status_code` (FINISHED / IN_PROGRESS / ERROR / EXPIRED / PUBLISHED) → check `content_publishing_limit` (100 posts / 24 h) → `POST /<IG_ID>/media_publish` → `GET /<MEDIA_ID>` to confirm.
5. **Published** is shown only after step 4's confirmation, with the permalink.

Duplicate posts: `media_publish` is not idempotent. The state is written *before* calling it. If the outcome is unknown (timeout, network), it is **never** called again blindly: the container status is checked; `PUBLISHED` → the post is looked up by caption and time; `FINISHED` → not published, retry allowed; otherwise the publication stops in **needs_review** for a person to check.

Retries only for transient errors (5xx, rate limits, codes 1/2/4/17/32/613). Token errors (code 190) mark the connection *expired* and need reconnecting. Kill switch: pausing the connection holds queued publications before anything is created.

## 8. Testing the connection without posting

1. Configure the variables above (storage can wait).
2. Integrations → **ربط حساب Instagram** → approve on Instagram → you return with "تم ربط حساب Instagram بنجاح".
3. Check the card: username, account type, granted permissions, token expiry.
4. **مزامنة الآن** re-reads the profile and the publishing quota. This makes no post.
5. Webhook check from a terminal (replace values):

```bash
curl -i "https://<domain>/api/v1/webhooks/meta?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=12345"
```

   Expect `200` with body `12345`. Use the dashboard's **Test** button for a signed sample event.
6. To test publishing safely, use a **test Instagram account** added as a tester, not the business account.

## What still needs you

- Meta app + App Review for the permissions above.
- A public domain or tunnel for OAuth and webhooks.
- A storage bucket and its keys.
- `SECRETS_ENCRYPTION_KEY` in the web and worker hosts.
