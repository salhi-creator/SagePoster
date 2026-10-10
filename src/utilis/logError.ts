type ErrorContext = Record<string, string | number | boolean | undefined>;

export function logError(
  scope: string,
  error: unknown,
  context: ErrorContext = {},
): void {
  const value = error instanceof Error ? error : new Error(String(error));
  const details = error as {
    code?: unknown;
    response?: { status?: unknown };
  } | null;
  const safeMessage = value.message.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]");

  console.error(`[${scope}]`, {
    ...context,
    error: {
      name: value.name,
      message: safeMessage,
      code: details?.code,
      httpStatus: details?.response?.status,
    },
  });
}
