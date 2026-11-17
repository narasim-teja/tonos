import { describe, expect, test } from "bun:test";
import { parseExport } from "../src/whoop/export";
import { WHOOP, WhoopClient, normalizeCycle, normalizeSleep, normalizeWorkout, type TokenVault, type Tokens } from "../src/whoop/api";
import { EXAMPLE_DIR } from "./helpers";

/** Shapes match the v2 responses seen on 2026-11-16; values are fictional. */
const apiCycle = {
  id: 93845, user_id: 10129, created_at: "2026-03-08T11:25:44.774Z", updated_at: "2026-03-08T14:25:44.774Z",
  start: "2026-03-08T05:05:30.250Z", end: "2026-03-09T04:41:12.000Z", timezone_offset: "-04:00", score_state: "SCORED",
  score: { strain: 14.2, kilojoule: 11757.0, average_heart_rate: 79, max_heart_rate: 171 }, step_count: 9120,
};
const apiRecovery = {
  cycle_id: 93845, sleep_id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8", user_id: 10129, score_state: "SCORED",
  score: { user_calibrating: false, recovery_score: 45, resting_heart_rate: 58, hrv_rmssd_milli: 61.2, spo2_percentage: 95.4, skin_temp_celsius: 33.9 },
};
const apiSleep = {
  id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8", cycle_id: 93845, v1_id: null, user_id: 10129,
  start: "2026-03-08T05:05:30.000Z", end: "2026-03-08T11:40:02.000Z", timezone_offset: "-04:00", nap: false, score_state: "SCORED",
  score: {
    stage_summary: {
      total_in_bed_time_milli: 23_640_000, total_awake_time_milli: 2_400_000, total_no_data_time_milli: 0,
      total_light_sleep_time_milli: 11_400_000, total_slow_wave_sleep_time_milli: 5_040_000, total_rem_sleep_time_milli: 4_800_000,
      sleep_cycle_count: 4, disturbance_count: 9,
    },
    sleep_needed: { baseline_milli: 27_000_000, need_from_sleep_debt_milli: 2_760_000, need_from_recent_strain_milli: 240_000, need_from_recent_nap_milli: 0 },
    respiratory_rate: 15.8, sleep_performance_percentage: 71, sleep_consistency_percentage: 62, sleep_efficiency_percentage: 90,
  },
};
const apiWorkout = {
  id: "7a1f2c40-0d3c-4a55-9f6e-2b8d1c0e9a11", v1_id: null, user_id: 10129, start: "2026-03-08T21:30:00.000Z",
  end: "2026-03-08T22:45:00.000Z", timezone_offset: "-04:00", sport_name: "tennis", score_state: "SCORED", sport_id: 34,
  score: {
    strain: 12.1, average_heart_rate: 138, max_heart_rate: 172, kilojoule: 2677.8, percent_recorded: 100,
    distance_meter: null, altitude_gain_meter: null, altitude_change_meter: null,
    zone_durations: { zone_zero_milli: 0, zone_one_milli: 990_000, zone_two_milli: 1_395_000, zone_three_milli: 1_260_000, zone_four_milli: 630_000, zone_five_milli: 135_000 },
  },
};

describe("normalizing API responses", () => {
  const exported = parseExport(EXAMPLE_DIR);

  test("an API cycle gets the same id as the export row for the same cycle", () => {
    const cycle = normalizeCycle(apiCycle, apiRecovery);
    expect(cycle.id).toBe(exported.cycles.find(row => row.start === "2026-03-08T01:05:30-04:00")!.id);
    expect(cycle).toMatchObject({ source: "api", whoop_id: "93845", start: "2026-03-08T01:05:30-04:00", step_count: 9120 });
    expect(cycle.energy_kcal).toBe(2810); // 11757 kJ / 4.184
    expect(cycle.recovery).toMatchObject({ recovery_score: 45, hrv_rmssd_ms: 61.2 });
  });

  test("today's cycle from the API is open but already scored", () => {
    const open = normalizeCycle({ ...apiCycle, end: null }, undefined);
    expect(open.end).toBeNull();
    expect(open.strain).toBe(14.2);
    expect(open.recovery).toBeNull();
  });

  test("pending and unscorable records keep their state and carry no numbers", () => {
    expect(normalizeCycle({ ...apiCycle, score_state: "PENDING_SCORE", score: null }, undefined)).toMatchObject({ score_state: "PENDING_SCORE", strain: null });
    expect(normalizeSleep({ ...apiSleep, score_state: "UNSCORABLE", score: null })).toMatchObject({ score_state: "UNSCORABLE", asleep_min: null });
  });

  test("sleep stages become whole minutes and match the export's numbers", () => {
    const sleep = normalizeSleep(apiSleep);
    const row = exported.sleeps.find(record => record.start === "2026-03-08T01:05:30-04:00")!;
    expect(sleep.id).toBe(row.id);
    for (const field of ["light_min", "deep_min", "rem_min", "asleep_min", "in_bed_min", "awake_min", "need_min", "debt_min"] as const) {
      expect(sleep[field]).toBe(row[field]);
    }
  });

  test("workout zone time becomes a share of the workout, like the export", () => {
    const workout = normalizeWorkout(apiWorkout);
    expect(workout).toMatchObject({ activity: "Tennis", duration_min: 75, energy_kcal: 640, gps: null, distance_m: null });
    expect(workout.heart_rate_zones_percent).toEqual({ zone_1: 22, zone_2: 31, zone_3: 28, zone_4: 14, zone_5: 3 });
  });
});

function memoryVault(initial: Tokens | null): TokenVault & { saved: Tokens[] } {
  let current = initial;
  const saved: Tokens[] = [];
  return {
    saved,
    async load() { return current; },
    async save(tokens) { current = tokens; saved.push(tokens); },
    async clear() { current = null; },
  };
}

/** A fake WHOOP: rotates refresh tokens and rejects a reused one, as the real one does. */
function fakeWhoop() {
  let validRefresh = "refresh-1";
  let validAccess = "access-1";
  let generation = 1;
  const calls = { token: 0, api: [] as string[] };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.href === WHOOP.token) {
      calls.token += 1;
      const body = new URLSearchParams(String(init?.body));
      await Bun.sleep(5);
      if (body.get("refresh_token") !== validRefresh) return new Response('{"error":"invalid_grant"}', { status: 400 });
      generation += 1;
      validRefresh = `refresh-${generation}`;
      validAccess = `access-${generation}`;
      return Response.json({ access_token: validAccess, refresh_token: validRefresh, expires_in: 3600, scope: "offline" });
    }
    calls.api.push(url.pathname + url.search);
    if (new Headers(init?.headers).get("Authorization") !== `Bearer ${validAccess}`) return new Response("", { status: 401 });
    if (url.pathname === "/developer/v2/activity/workout") {
      const page = url.searchParams.get("nextToken") === null
        ? { records: [apiWorkout], next_token: "page-2" }
        : { records: [{ ...apiWorkout, id: "second", start: "2026-03-09T21:30:00.000Z", end: "2026-03-09T22:00:00.000Z" }], next_token: null };
      return Response.json(page);
    }
    return Response.json({ records: [], next_token: null });
  }) as typeof fetch;
  return { fetcher, calls, revoke: () => { validAccess = "revoked"; } };
}

const credentials = { clientId: "id", clientSecret: "secret" };

describe("live client", () => {
  test("concurrent calls with an expired token share one refresh, and the rotated token is saved", async () => {
    const whoop = fakeWhoop();
    const vault = memoryVault({ access_token: "access-1", refresh_token: "refresh-1", expires_at: 0 });
    const client = new WhoopClient(credentials, vault, whoop.fetcher);
    await Promise.all(Array.from({ length: 5 }, () => client.get("/v2/cycle")));
    expect(whoop.calls.token).toBe(1);
    expect(vault.saved.at(-1)).toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
  });

  test("a 401 refreshes once and retries", async () => {
    const whoop = fakeWhoop();
    const vault = memoryVault({ access_token: "stale", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000 });
    await new WhoopClient(credentials, vault, whoop.fetcher).get("/v2/cycle");
    expect(whoop.calls.token).toBe(1);
    expect(whoop.calls.api).toHaveLength(2);
  });

  test("a rejected refresh token asks the user to log in again", async () => {
    const whoop = fakeWhoop();
    const vault = memoryVault({ access_token: "x", refresh_token: "already-rotated", expires_at: 0 });
    await expect(new WhoopClient(credentials, vault, whoop.fetcher).get("/v2/cycle")).rejects.toThrow("Run `tonos auth login` again");
  });

  test("pages are followed and records filtered to the requested local days", async () => {
    const whoop = fakeWhoop();
    const vault = memoryVault({ access_token: "access-1", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000 });
    const client = new WhoopClient(credentials, vault, whoop.fetcher);
    const both = await client.workouts({ from: "2026-03-08", to: "2026-03-09", limit: 25 });
    expect(both.map(workout => workout.start)).toEqual(["2026-03-08T17:30:00-04:00", "2026-03-09T17:30:00-04:00"]);
    const one = await client.workouts({ from: "2026-03-08", to: "2026-03-08", limit: 25 });
    expect(one).toHaveLength(1);
  });
});
