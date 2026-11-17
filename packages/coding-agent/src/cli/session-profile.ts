/**
 * Which profile a launch activates when it opens an existing session.
 *
 * A named profile keeps its sessions under its own config root
 * (`<omp home>/profiles/<name>/agent/sessions`, see `getProfileRootDir`), so a
 * `--restore`/`--resume` of such a file must activate that profile: without it
 * the launch reads the default profile's auth and model registry, and a saved
 * model the profile's credentials serve fails to restore.
 *
 * The session path decides only when no `--profile` was given. An explicit
 * `--profile` that names a different profile is a mistake worth refusing: the
 * launch would open the file with the wrong credentials, which is the failure
 * this module exists to prevent.
 */
import { normalizeProfileName, profileFromSessionPath } from "@oh-my-pi/pi-utils/dirs";

/** Where the launch's profile comes from. */
export type SessionProfileChoice =
	/** `--profile` was given; `profile` is undefined for the default profile. */
	| { kind: "flag"; profile: string | undefined }
	/** No `--profile`; the session file lives in this named profile's root. */
	| { kind: "session"; profile: string }
	/** Neither names a profile; the caller falls back to `OMP_PROFILE`/`PI_PROFILE`. */
	| { kind: "none" };

/**
 * Resolve the profile a launch activates from its `--profile` value and the
 * session source it opens (`--resume`, `--restore`, `--session`).
 *
 * Throws when `--profile` names a different profile than the one owning
 * `sessionSource`.
 */
export function chooseSessionProfile(
	explicitProfile: string | undefined,
	sessionSource: string | undefined,
): SessionProfileChoice {
	const fromSession = sessionSource === undefined ? undefined : profileFromSessionPath(sessionSource);
	if (explicitProfile === undefined) {
		return fromSession === undefined ? { kind: "none" } : { kind: "session", profile: fromSession };
	}
	const explicit = normalizeProfileName(explicitProfile);
	if (fromSession !== undefined && fromSession !== explicit) {
		throw new Error(
			`--profile ${explicitProfile} does not match the session's profile "${fromSession}": ` +
				`${sessionSource} belongs to profile "${fromSession}". ` +
				`Run with --profile ${fromSession}, or without --profile.`,
		);
	}
	return { kind: "flag", profile: explicit };
}
