export class AiProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}

export class AiNotConfiguredError extends Error {
  constructor(readonly reason: string) {
    super(`AI provider is not configured: ${reason}`);
    this.name = "AiNotConfiguredError";
  }
}

export class AiOutputInvalidError extends Error {
  constructor(readonly issues: string) {
    super(`AI output failed validation: ${issues}`);
    this.name = "AiOutputInvalidError";
  }
}

export class AiBudgetExceededError extends Error {
  constructor(
    readonly estimatedUsd: number,
    readonly remainingUsd: number,
  ) {
    super(`Estimated AI cost ${estimatedUsd.toFixed(4)} USD exceeds remaining budget ${remainingUsd.toFixed(4)} USD`);
    this.name = "AiBudgetExceededError";
  }
}
