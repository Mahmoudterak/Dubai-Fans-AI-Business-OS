# Meta / Instagram app setup (for phase 6)

The integration code is **not built yet**. These are the steps to prepare the Meta side so phase 6 can start immediately.

1. **Instagram account**: switch it to a Professional account (Business or Creator) and link it to a Facebook Page you manage.
2. **Meta developer app**: create an app at developers.facebook.com (type: Business). Add the products *Instagram* (Instagram API with Facebook Login) and *Webhooks*.
3. **OAuth redirect**: add `https://<domain>/api/v1/integrations/meta/callback` (and `http://localhost:3000/...` for development) to the valid OAuth redirect URIs.
4. **Permissions** the app will request (each needs Meta App Review for production use):
   `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`, and for the inbox later `instagram_manage_messages`.
5. **Webhooks**: callback `https://<domain>/api/v1/webhooks/meta`, verify token = a random value you put in `META_WEBHOOK_VERIFY_TOKEN`. Signatures are verified with `META_APP_SECRET` (`X-Hub-Signature-256`).
6. **Environment**: set `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, `META_WEBHOOK_VERIFY_TOKEN` in Vercel and the worker host. Do not paste them into chat or commit them.
7. **App review**: record a screencast of the approval flow (submit → approve → publish) for the `instagram_content_publish` review.

Until then, the Integrations page shows Instagram as **not connected** and publishing is refused.
