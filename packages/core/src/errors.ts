export type ErrorParams = Record<string, string | number>;

/**
 * Every error a person may see, by code. The interface has a message for each
 * one in every language; adding a code here means adding it to the catalogs.
 */
export const ERROR_CODES = [
	"assetNotFound",
	"assistantBusy",
	"badCredentials",
	"badPassword",
	"badSetupCode",
	"badTotp",
	"captionNeedsModel",
	"checkpointMissing",
	"checkpointNeedsEngine",
	"checkpointSettingsInvalid",
	"checkpointTooLarge",
	"checkpointUnknownBase",
	"checkpointUnreadable",
	"claudeConfigUnreadable",
	"claudeNotFound",
	"confirmNotWaiting",
	"connectionLost",
	"downloadCutShort",
	"downloadFailed",
	"downloadTooLarge",
	"emptyKey",
	"engineDoesNotRun",
	"engineExitCode",
	"engineMissing",
	"engineNoResult",
	"engineStopped",
	"engineUnpackFailed",
	"folderInside",
	"folderNotAbsolute",
	"folderNotShared",
	"folderNotWritable",
	"forbidden",
	"hashMismatch",
	"improveFailed",
	"interrupted",
	"inviteInvalid",
	"jobNotFound",
	"jobNotRetryable",
	"lastOwner",
	"localAssistantUnavailable",
	"loraMissing",
	"loraQuotaReached",
	"loraTooLarge",
	"loraUnknownBase",
	"loraUnreadable",
	"loraWrongBase",
	"maskWithoutReference",
	"modelDoesNotRun",
	"modelsBusy",
	"modelsFolderFixed",
	"modelsMoveFailed",
	"modelsMoveLeftCopies",
	"modelsMoving",
	"modelUnavailable",
	"monthlyLimitReached",
	"needsPicture",
	"noApiKey",
	"noConnection",
	"noLanguageModel",
	"noMask",
	"noModel",
	"noReferences",
	"noResult",
	"notEnoughDisk",
	"notInstalled",
	"notOnServer",
	"paidNotAllowed",
	"passwordChangeRequired",
	"passwordTooShort",
	"providerBusy",
	"referenceNotFound",
	"referenceNotImage",
	"referenceUnreadable",
	"resetInvalid",
	"resultDownloadFailed",
	"resultNotHttps",
	"resultTooLarge",
	"sessionNotFound",
	"signInRequired",
	"tooManyAttempts",
	"tooManyLoras",
	"tooManyReferences",
	"totpRequired",
	"trainerBusy",
	"trainerInstallFailed",
	"trainerMissing",
	"trainerNoCuda",
	"trainingBadName",
	"trainingBadSteps",
	"trainingBadTrigger",
	"trainingFailed",
	"trainingNeedsBase",
	"trainingNeedsConsent",
	"trainingNeedsPictures",
	"trainingNothingSaved",
	"trainingOutOfMemory",
	"unknownLocalModel",
	"unknownModel",
	"unknownProvider",
	"unknownVariant",
	"uploadType",
	"usernameInvalid",
	"usernameTaken",
	"variantDoesNotRun",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * An error a person may see. Its `code` lets the interface show it in the
 * reader's language; `message` is the English text, for logs and for clients
 * that do not know the code. Values a message mentions go in `params`; byte
 * counts are named with a `Bytes` suffix so the interface can format them.
 */
export class CodedError extends Error {
	constructor(
		message: string,
		readonly code?: ErrorCode,
		readonly params: ErrorParams = {},
		/** Set when trying again may work: the failure was passing. */
		readonly retry?: Retry,
	) {
		super(message);
	}
}

/**
 * A failure worth trying again, because nothing was done and nothing was
 * charged (a provider refusing for now, a connection never made) or because
 * it costs nothing (a local engine that crashed).
 */
export interface Retry {
	/** How long the provider asked to wait, when it said. */
	afterMs?: number;
	/** Tries in all, the first included; the engine's default otherwise. */
	attempts?: number;
}

/** The request is malformed or asks for something a model cannot do. */
export class ValidationError extends CodedError {}

export class NotFoundError extends CodedError {}

/**
 * Who is asking may not: 401 when nobody is signed in or the sign-in failed,
 * 403 when the person may not do this, 429 when they tried too often.
 */
export class AccessError extends CodedError {
	constructor(
		message: string,
		code: ErrorCode,
		readonly status: 401 | 403 | 429,
		params: ErrorParams = {},
	) {
		super(message, code, params);
	}
}

/** What to tell a person about an error: its message, and a code when known. */
export function describeError(error: unknown): {
	message: string;
	code: string | null;
	params: ErrorParams | null;
} {
	if (error instanceof CodedError && error.code) {
		return { message: error.message, code: error.code, params: error.params };
	}
	return {
		message: error instanceof Error ? error.message : String(error),
		code: null,
		params: null,
	};
}
