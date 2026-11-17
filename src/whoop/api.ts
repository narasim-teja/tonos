import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { LiveSource } from "../core/actions";
import { recordDay } from "../core/day";
import {
  SCHEMA_VERSION, cycleSchema, sleepSchema, workoutSchema, type Cycle, type Range, type Sleep, type Workout,
} from "../core/schema";
import { apiInstant, minutesBetween, recordId } from "../core/time";

export const WHOOP = {
  authorize: "https://api.prod.whoop.com/oauth/oauth2/auth",
  token: "https://api.prod.whoop.com/oauth/oauth2/token",
  api: "https://api.prod.whoop.com/developer",
  scopes: ["offline", "read:recovery", "read:cycles", "read:sleep", "read:workout", "read:profile", "read:body_measurement"],
} as const;

/** Each user registers their own WHOOP app; this project ships no credentials (WHOOP API Terms §3). */
export type Credentials = { clientId: string; clientSecret: string };

export type Tokens = { access_token: string; refresh_token: string; expires_at: number };

/** Where OAuth tokens live. The default is the OS keychain via Bun.secrets: encrypted at rest, never in the data directory. */
export interface TokenVault {
  load(): Promise<Tokens | null>;
  save(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

const tokensSchema = z.strictObject({ access_token: z.string(), refresh_token: z.string(), expires_at: z.number() });

/** Keychain-backed vault. One entry per data directory, so separate stores do not share a WHOOP login. */
export function keychainVault(account: string): TokenVault {
  const key = { service: "tonos.whoop-oauth", name: account };
  return {
    async load() {
      const value = await Bun.secrets.get(key);
      if (value === null) return null;
      const parsed = tokensSchema.safeParse(JSON.parse(value));
      return parsed.success ? parsed.data : null;
    },
    async save(tokens) { await Bun.secrets.set({ ...key, value: JSON.stringify(tokens) }); },
    async clear() { await Bun.secrets.delete(key); },
  };
}

/** Credentials from the environment (Bun loads `.env`). Never from the repository. */
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): Credentials | null {
  const clientId = env.WHOOP_CLIENT_ID?.trim();
  const clientSecret = env.WHOOP_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

async function tokenRequest(fetcher: typeof fetch, credentials: Credentials, params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetcher(WHOOP.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, client_id: credentials.clientId, client_secret: credentials.clientSecret }),
  });
  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`WHOOP token endpoint returned ${response.status}.`) as Error & { status: number; detail: string };
    error.status = response.status;
    error.detail = body.slice(0, 200);
    throw error;
  }
  return JSON.parse(body) as TokenResponse;
}

function toTokens(response: TokenResponse, previousRefresh: string | null, now: number): Tokens {
  const refresh = response.refresh_token ?? previousRefresh;
  if (!refresh) throw new Error("WHOOP did not return a refresh token. The app must request the offline scope.");
  return { access_token: response.access_token, refresh_token: refresh, expires_at: now + response.expires_in * 1000 };
}

/**
 * OAuth authorization-code login over a loopback redirect. WHOOP accepts
 * `http://127.0.0.1:<port>/callback` as a registered redirect (verified 2026-11-16).
 * The listener binds to 127.0.0.1 only, checks `state`, and closes after one callback.
 */
export async function login(options: {
  credentials: Credentials; vault: TokenVault; port?: number; open?: (url: string) => void;
  fetcher?: typeof fetch; timeoutMs?: number;
}): Promise<{ scopes: string }> {
  const port = options.port ?? 8765;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomBytes(16).toString("hex");
  const fetcher = options.fetcher ?? fetch;
  const url = new URL(WHOOP.authorize);
  url.search = new URLSearchParams({
    response_type: "code", client_id: options.credentials.clientId, redirect_uri: redirectUri,
    scope: WHOOP.scopes.join(" "), state,
  }).toString();

  let settle!: (value: { code: string } | { error: string }) => void;
  const outcome = new Promise<{ code: string } | { error: string }>(resolve => { settle = resolve; });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const callback = new URL(request.url);
      if (callback.pathname !== "/callback") return new Response("Not found", { status: 404 });
      if (callback.searchParams.get("state") !== state) return new Response("State mismatch.", { status: 400 });
      const error = callback.searchParams.get("error");
      const code = callback.searchParams.get("code");
      settle(error !== null || code === null ? { error: error ?? "no_code" } : { code });
      return new Response(error === null ? "Connected. You can close this tab." : `Authorization failed: ${error}`);
    },
  });
  const timer = setTimeout(() => settle({ error: "timed out waiting for the WHOOP sign-in" }), options.timeoutMs ?? 300_000);
  try {
    (options.open ?? (target => Bun.spawn(["open", target])))(url.toString());
    const result = await outcome;
    if ("error" in result) throw new Error(`WHOOP authorization failed: ${result.error}`);
    const response = await tokenRequest(fetcher, options.credentials, {
      grant_type: "authorization_code", code: result.code, redirect_uri: redirectUri,
    });
    await options.vault.save(toTokens(response, null, Date.now()));
    return { scopes: (response as TokenResponse & { scope?: string }).scope ?? WHOOP.scopes.join(" ") };
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}


type Page<T> = { records: T[]; next_token?: string | null };

const kcal = (kilojoule: number | null | undefined) => kilojoule == null ? null : Math.round(kilojoule / 4.184);
const minutes = (milli: number | null | undefined) => milli == null ? null : Math.round(milli / 60_000);
const offsetOf = (value: string) => z.string().regex(/^[+-]\d{2}:\d{2}$/).parse(value === "Z" ? "+00:00" : value);
const stateOf = (value: string) => z.enum(["SCORED", "PENDING_SCORE", "UNSCORABLE"]).parse(value);

type ApiCycle = {
  id: number; start: string; end: string | null; timezone_offset: string; score_state: string; step_count?: number | null;
  score?: { strain?: number; kilojoule?: number; average_heart_rate?: number; max_heart_rate?: number } | null;
};
type ApiRecovery = {
  cycle_id: number; score_state: string;
  score?: { recovery_score?: number; resting_heart_rate?: number; hrv_rmssd_milli?: number; spo2_percentage?: number; skin_temp_celsius?: number } | null;
};
type ApiSleep = {
  id: string; start: string; end: string; timezone_offset: string; nap: boolean; score_state: string;
  score?: {
    stage_summary?: Record<string, number>; sleep_needed?: Record<string, number>; respiratory_rate?: number;
    sleep_performance_percentage?: number; sleep_consistency_percentage?: number; sleep_efficiency_percentage?: number;
  } | null;
};
type ApiWorkout = {
  id: string; start: string; end: string; timezone_offset: string; sport_name: string; score_state: string;
  score?: {
    strain?: number; average_heart_rate?: number; max_heart_rate?: number; kilojoule?: number; distance_meter?: number | null;
    zone_durations?: Record<string, number>;
  } | null;
};

/** WHOOP cycle (+ its recovery) → the stored cycle shape, with `source: "api"`. */
export function normalizeCycle(cycle: ApiCycle, recovery: ApiRecovery | undefined): Cycle {
  const offset = offsetOf(cycle.timezone_offset);
  const start = apiInstant(cycle.start, offset);
  const scored = cycle.score_state === "SCORED" ? cycle.score ?? null : null;
  const r = recovery?.score_state === "SCORED" ? recovery.score ?? null : null;
  return cycleSchema.parse({
    schema_version: SCHEMA_VERSION, id: recordId("cycle", start), kind: "cycle", source: "api", whoop_id: String(cycle.id),
    start, end: cycle.end === null ? null : apiInstant(cycle.end, offset), timezone_offset: offset,
    score_state: stateOf(cycle.score_state),
    strain: scored?.strain ?? null, energy_kcal: kcal(scored?.kilojoule),
    average_heart_rate: scored?.average_heart_rate ?? null, max_heart_rate: scored?.max_heart_rate ?? null,
    step_count: cycle.step_count ?? null,
    recovery: r === null ? null : {
      recovery_score: r.recovery_score ?? null, resting_heart_rate: r.resting_heart_rate ?? null,
      hrv_rmssd_ms: r.hrv_rmssd_milli ?? null, spo2_percent: r.spo2_percentage ?? null,
      skin_temp_celsius: r.skin_temp_celsius ?? null,
    },
  } satisfies Cycle);
}

/** WHOOP sleep → the stored sleep shape. Stage times arrive in milliseconds; stored as whole minutes like the export. */
export function normalizeSleep(sleep: ApiSleep): Sleep {
  const offset = offsetOf(sleep.timezone_offset);
  const start = apiInstant(sleep.start, offset);
  const s = sleep.score_state === "SCORED" ? sleep.score ?? null : null;
  const stages = s?.stage_summary ?? {};
  const need = s?.sleep_needed;
  const light = minutes(stages.total_light_sleep_time_milli);
  const deep = minutes(stages.total_slow_wave_sleep_time_milli);
  const rem = minutes(stages.total_rem_sleep_time_milli);
  return sleepSchema.parse({
    schema_version: SCHEMA_VERSION, id: recordId("sleep", start), kind: "sleep", source: "api", whoop_id: sleep.id,
    start, end: apiInstant(sleep.end, offset), timezone_offset: offset, score_state: stateOf(sleep.score_state),
    nap: sleep.nap, cycle_id: null,
    performance_percent: s?.sleep_performance_percentage ?? null, consistency_percent: s?.sleep_consistency_percentage ?? null,
    efficiency_percent: s?.sleep_efficiency_percentage ?? null, respiratory_rate: s?.respiratory_rate ?? null,
    asleep_min: light === null || deep === null || rem === null ? null : light + deep + rem,
    in_bed_min: minutes(stages.total_in_bed_time_milli), light_min: light, deep_min: deep, rem_min: rem,
    awake_min: minutes(stages.total_awake_time_milli),
    need_min: need ? minutes(Object.values(need).reduce((sum, value) => sum + value, 0)) : null,
    debt_min: minutes(need?.need_from_sleep_debt_milli),
  } satisfies Sleep);
}

/** WHOOP workout → the stored workout shape. Zone time becomes a share of the workout, as in the export. */
export function normalizeWorkout(workout: ApiWorkout): Workout {
  const offset = offsetOf(workout.timezone_offset);
  const start = apiInstant(workout.start, offset);
  const end = apiInstant(workout.end, offset);
  const s = workout.score_state === "SCORED" ? workout.score ?? null : null;
  const durationMs = Date.parse(workout.end) - Date.parse(workout.start);
  const zones = s?.zone_durations;
  const share = (milli: number | undefined) => milli === undefined || durationMs <= 0 ? null : Math.round(milli / durationMs * 1000) / 10;
  return workoutSchema.parse({
    schema_version: SCHEMA_VERSION, id: recordId("workout", start), kind: "workout", source: "api", whoop_id: workout.id,
    start, end, timezone_offset: offset, score_state: stateOf(workout.score_state), cycle_id: null,
    activity: workout.sport_name.split(/[-_ ]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ") || "Activity",
    duration_min: minutesBetween(start, end), strain: s?.strain ?? null, energy_kcal: kcal(s?.kilojoule),
    average_heart_rate: s?.average_heart_rate ?? null, max_heart_rate: s?.max_heart_rate ?? null,
    heart_rate_zones_percent: zones === undefined ? null : {
      zone_1: share(zones.zone_one_milli), zone_2: share(zones.zone_two_milli), zone_3: share(zones.zone_three_milli),
      zone_4: share(zones.zone_four_milli), zone_5: share(zones.zone_five_milli),
    },
    distance_m: s?.distance_meter ?? null, gps: s?.distance_meter == null ? null : true,
  } satisfies Workout);
}

/**
 * A live client. Refreshes ahead of expiry, saves each rotated refresh token before using
 * it, and lets only one refresh run at a time: WHOOP rotates refresh tokens and rejects the
 * old one (verified 2026-11-16), so two concurrent refreshes would race.
 */
export class WhoopClient implements LiveSource {
  private refreshing: Promise<Tokens> | null = null;

  constructor(private credentials: Credentials, private vault: TokenVault, private fetcher: typeof fetch = fetch,
    private now: () => number = Date.now) {}

  /** Single-flight refresh. Concurrent callers share one token request. */
  refresh(): Promise<Tokens> {
    this.refreshing ??= (async () => {
      try {
        const current = await this.vault.load();
        if (current === null) throw new Error("Not logged in to WHOOP. Run `tonos auth login`.");
        let response: TokenResponse;
        try {
          response = await tokenRequest(this.fetcher, this.credentials, {
            grant_type: "refresh_token", refresh_token: current.refresh_token, scope: "offline",
          });
        } catch (error) {
          if ((error as { status?: number }).status === 400 || (error as { status?: number }).status === 401) {
            throw new Error("WHOOP rejected the saved login (revoked or already rotated). Run `tonos auth login` again.");
          }
          throw error;
        }
        const tokens = toTokens(response, current.refresh_token, this.now());
        await this.vault.save(tokens);
        return tokens;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async accessToken(): Promise<string> {
    const tokens = await this.vault.load();
    if (tokens === null) throw new Error("Not logged in to WHOOP. Run `tonos auth login`.");
    if (tokens.expires_at - 60_000 > this.now()) return tokens.access_token;
    return (await this.refresh()).access_token;
  }

  /** GET with one retry after a 401 (refresh) and one after a 429 (waits for the reset window, capped at 60 s). */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(WHOOP.api + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let token = await this.accessToken();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.fetcher(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) return await response.json() as T;
      if (response.status === 401 && attempt === 0) { token = (await this.refresh()).access_token; continue; }
      if (response.status === 429 && attempt < 2) {
        const wait = Math.min(Number(response.headers.get("x-ratelimit-reset") ?? "5"), 60);
        await Bun.sleep(wait * 1000);
        continue;
      }
      throw new Error(`WHOOP API ${path} returned ${response.status}.`);
    }
    throw new Error(`WHOOP API ${path} kept failing.`);
  }

  /** Every page in a window, up to `limit` records. WHOOP pages hold at most 25. */
  private async collect<T>(path: string, range: Range, limit: number): Promise<T[]> {
    // Local dates do not pin an instant until we know each record's offset, so ask for a
    // window one day wider on each side and filter by local day afterwards.
    const start = new Date(Date.parse(`${range.from}T00:00:00Z`) - 86_400_000).toISOString();
    const end = new Date(Date.parse(`${range.to}T00:00:00Z`) + 2 * 86_400_000).toISOString();
    const out: T[] = [];
    let next: string | null | undefined;
    do {
      const page = await this.get<Page<T>>(path, {
        start, end, limit: "25", ...(next ? { nextToken: next } : {}),
      });
      out.push(...page.records);
      next = page.next_token;
    } while (next && out.length < limit * 2);
    return out;
  }

  private inRange<T extends Cycle | Sleep | Workout>(records: T[], range: Range, limit: number): T[] {
    return records.filter(record => {
      const day = recordDay(record);
      return day !== null && day >= range.from && day <= range.to;
    }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(-limit);
  }

  async cycles(input: Range & { limit: number }): Promise<Cycle[]> {
    const [cycles, recoveries] = await Promise.all([
      this.collect<ApiCycle>("/v2/cycle", input, input.limit),
      this.collect<ApiRecovery>("/v2/recovery", input, input.limit),
    ]);
    const byCycle = new Map(recoveries.map(recovery => [recovery.cycle_id, recovery]));
    return this.inRange(cycles.map(cycle => normalizeCycle(cycle, byCycle.get(cycle.id))), input, input.limit);
  }

  async sleeps(input: Range & { limit: number }): Promise<Sleep[]> {
    return this.inRange((await this.collect<ApiSleep>("/v2/activity/sleep", input, input.limit)).map(normalizeSleep), input, input.limit);
  }

  async workouts(input: Range & { limit: number }): Promise<Workout[]> {
    return this.inRange((await this.collect<ApiWorkout>("/v2/activity/workout", input, input.limit)).map(normalizeWorkout), input, input.limit);
  }

  /** Revokes this app's access at WHOOP, then forgets the local tokens. */
  async logout(): Promise<{ revoked: boolean }> {
    let revoked = false;
    try {
      const token = await this.accessToken();
      const response = await this.fetcher(`${WHOOP.api}/v2/user/access`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      revoked = response.ok;
    } finally {
      await this.vault.clear();
    }
    return { revoked };
  }
}
