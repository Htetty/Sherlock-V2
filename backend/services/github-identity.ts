// GitHub identity extraction from a verified Supabase Auth user, plus profile
// synchronization against public.profiles.
//
// Identity model: the IMMUTABLE key is the GitHub numeric user id, always
// handled as a decimal string (never converted to a JavaScript number — the
// value space is not guaranteed to fit a double). GitHub login and avatar are
// mutable snapshots, never identity. Email is never an identity key and never
// stored here. The GitHub OAuth provider access token is never required,
// extracted, or persisted.

// --- Identity extraction ------------------------------------------------------

export type GitHubIdentity = {
  // Immutable GitHub numeric user id as a decimal string.
  githubUserId: string;
  // Mutable login snapshot.
  githubLogin: string;
  // Mutable avatar snapshot, or null.
  avatarUrl: string | null;
};

// Minimal structural shape of the Supabase Auth user object this module
// reads. Matches @supabase/supabase-js's User without importing its generics.
export type SupabaseAuthUserLike = {
  id: string;
  identities?:
    | Array<{
        provider?: string;
        id?: string;
        identity_data?: Record<string, unknown> | null;
      }>
    | null;
  user_metadata?: Record<string, unknown> | null;
};

const DECIMAL_DIGITS = /^\d{1,20}$/;

// Normalize a candidate GitHub numeric id into a decimal string. Strings must
// already be digits-only; numbers are accepted only when they are safe
// non-negative integers (a lossy double would corrupt the identity key).
function asDecimalIdString(value: unknown): string | null {
  if (typeof value === "string" && DECIMAL_DIGITS.test(value)) {
    return value;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }

  return null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asHttpUrlString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? value : null;
  } catch {
    return null;
  }
}

// Extract the GitHub identity from a verified Supabase user, or null when it
// cannot be determined (fail closed — callers must reject, never guess).
//
// Field precedence (documented Supabase GitHub identity metadata):
//   immutable id: identity_data.provider_id → identity_data.sub → identity.id
//   login:        identity_data.user_name → identity_data.preferred_username
//   avatar:       identity_data.avatar_url → user_metadata.avatar_url
export function extractGitHubIdentity(
  user: SupabaseAuthUserLike,
): GitHubIdentity | null {
  const identity = (user.identities ?? []).find(
    (candidate) => candidate?.provider === "github",
  );

  if (!identity) {
    return null;
  }

  const data = identity.identity_data ?? {};

  const githubUserId =
    asDecimalIdString(data.provider_id) ??
    asDecimalIdString(data.sub) ??
    asDecimalIdString(identity.id);

  if (githubUserId === null) {
    return null;
  }

  const githubLogin =
    asNonEmptyString(data.user_name) ??
    asNonEmptyString(data.preferred_username) ??
    asNonEmptyString(user.user_metadata?.user_name) ??
    asNonEmptyString(user.user_metadata?.preferred_username);

  if (githubLogin === null) {
    return null;
  }

  const avatarUrl =
    asHttpUrlString(data.avatar_url) ??
    asHttpUrlString(user.user_metadata?.avatar_url);

  return { githubUserId, githubLogin, avatarUrl };
}

// --- Profile synchronization --------------------------------------------------

export type ProfileRecord = {
  // Supabase auth.users id (uuid).
  id: string;
  githubUserId: string;
  githubLogin: string;
  avatarUrl: string | null;
};

// Injectable persistence seam; production uses the Supabase service-role
// implementation below, tests use in-memory fakes.
export interface ProfileStore {
  getById(id: string): Promise<ProfileRecord | null>;
  getByGithubUserId(githubUserId: string): Promise<ProfileRecord | null>;
  upsert(profile: ProfileRecord): Promise<void>;
}

// Identity conflicts fail closed: they are never auto-overwritten because
// either direction of overwrite would silently reassign installation access.
export class GitHubIdentityConflictError extends Error {
  constructor() {
    super("GitHub identity conflicts with an existing profile.");
    this.name = "GitHubIdentityConflictError";
  }
}

// Upsert the profile for a verified Supabase user:
//   - immutable github_user_id must stay consistent for this Supabase user;
//   - a GitHub user id already bound to a DIFFERENT Supabase user is rejected;
//   - mutable login/avatar snapshots are refreshed.
export async function syncProfile(
  store: ProfileStore,
  supabaseUserId: string,
  identity: GitHubIdentity,
): Promise<ProfileRecord> {
  const existing = await store.getById(supabaseUserId);

  if (existing && existing.githubUserId !== identity.githubUserId) {
    throw new GitHubIdentityConflictError();
  }

  const boundElsewhere = await store.getByGithubUserId(identity.githubUserId);

  if (boundElsewhere && boundElsewhere.id !== supabaseUserId) {
    throw new GitHubIdentityConflictError();
  }

  const profile: ProfileRecord = {
    id: supabaseUserId,
    githubUserId: identity.githubUserId,
    githubLogin: identity.githubLogin,
    avatarUrl: identity.avatarUrl,
  };

  await store.upsert(profile);
  return profile;
}

// --- Supabase-backed profile store --------------------------------------------
// Minimal structural surface of the service-role client (same pattern as the
// investigation state store): production casts the real client, tests fake it.

type ProfileRow = {
  id: string;
  github_user_id: string;
  github_login: string;
  avatar_url: string | null;
};

type SupabaseResponse<T> = { data: T; error: { message: string } | null };

export interface ProfilesClientLike {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): Promise<SupabaseResponse<ProfileRow | null>>;
      };
    };
    upsert(
      values: Record<string, unknown>,
      options: { onConflict: string },
    ): Promise<SupabaseResponse<unknown>>;
  };
}

function rowToProfile(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    avatarUrl: row.avatar_url ?? null,
  };
}

export function createSupabaseProfileStore(
  supabase: ProfilesClientLike,
): ProfileStore {
  const fetchBy = async (
    column: "id" | "github_user_id",
    value: string,
  ): Promise<ProfileRecord | null> => {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, github_user_id, github_login, avatar_url")
      .eq(column, value)
      .maybeSingle();

    if (error) {
      throw new Error(`Profile read failed: ${error.message}`);
    }

    return data ? rowToProfile(data) : null;
  };

  return {
    getById: (id) => fetchBy("id", id),
    getByGithubUserId: (githubUserId) => fetchBy("github_user_id", githubUserId),
    upsert: async (profile) => {
      const { error } = await supabase.from("profiles").upsert(
        {
          id: profile.id,
          github_user_id: profile.githubUserId,
          github_login: profile.githubLogin,
          avatar_url: profile.avatarUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

      if (error) {
        throw new Error(`Profile write failed: ${error.message}`);
      }
    },
  };
}
