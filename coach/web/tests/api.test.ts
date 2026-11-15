import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  SERVER_UNREACHABLE_MESSAGE,
  downloadUrl,
  fetchCurrentJob,
  fetchScore,
  fetchScores,
  postAttempt,
  removeScore,
  removeUrl,
  scoreUrl,
  scoresUrl,
  setupUrl,
  startDownload,
  startSetup,
} from "../src/api.ts";
import type { FetchLike, Job, Score, ScoreList } from "../src/api.ts";

const sampleList: ScoreList = {
  scores: [],
  total: 0,
  facets: { keys: [], times: [], difficulties: [] },
  sources: [],
};

const sampleScore: Score = {
  id: "local:abc",
  num: 1,
  title: "Fur Elise",
  composer: "Beethoven",
  artist: null,
  difficulty: 2,
  key: "A minor",
  time: "3/8",
  seconds: 95,
  piano_only: true,
  source: "local",
  attribution: null,
  license: null,
  license_url: null,
  format: "musicxml",
  has_file: true,
  file_url: "/api/scores/local%3Aabc/file",
};

const sampleJob: Job = {
  id: 7,
  kind: "download",
  source: "pdmx",
  target: "pdmx:Qm A",
  label: "Download Fur Elise",
  state: "running",
  phase: "Downloading the score archive",
  done: 1900000000,
  total: null,
  unit: "bytes",
  message: null,
  error: null,
};

function okFetch(body: unknown, seen: string[]): FetchLike {
  return async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => body };
  };
}

test("scoresUrl with no params has no query string", () => {
  assert.equal(scoresUrl({}), "/api/scores");
});

test("scoresUrl trims values, skips empty ones and keeps param order", () => {
  assert.equal(
    scoresUrl({ q: " fur elise ", difficulty: "", key: "E minor", time: "3/4" }),
    "/api/scores?q=fur+elise&key=E+minor&time=3%2F4",
  );
});

test("scoresUrl adds limit after the filters", () => {
  assert.equal(scoresUrl({ difficulty: "2" }, 50), "/api/scores?difficulty=2&limit=50");
});

test("scoreUrl encodes the id", () => {
  assert.equal(scoreUrl("local:abc"), "/api/scores/local%3Aabc");
});

test("downloadUrl encodes the id and adds /download", () => {
  assert.equal(downloadUrl("pdmx:Qm A"), "/api/scores/pdmx%3AQm%20A/download");
});

test("removeUrl encodes the id and adds /delete", () => {
  assert.equal(removeUrl("local:a b"), "/api/scores/local%3Aa%20b/delete");
});

test("setupUrl encodes the source and step", () => {
  assert.equal(setupUrl("pdmx", "catalogue"), "/api/sources/pdmx/setup/catalogue");
});

test("fetchScores requests the url and returns the json", async () => {
  const seen: string[] = [];
  const result = await fetchScores({ q: "bach" }, okFetch(sampleList, seen));
  assert.deepEqual(seen, ["/api/scores?q=bach"]);
  assert.deepEqual(result, sampleList);
});

test("fetchScores with an unreachable server throws ApiError status 0", async () => {
  const rejecting: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(fetchScores({}, rejecting), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(err.message, SERVER_UNREACHABLE_MESSAGE);
    return true;
  });
});

test("fetchScores with a 400 JSON error throws that message", async () => {
  const badRequest: FetchLike = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: "bad difficulty" }),
  });
  await assert.rejects(fetchScores({ difficulty: "x" }, badRequest), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "bad difficulty");
    assert.equal(err.status, 400);
    return true;
  });
});

test("fetchScores with a 500 non-JSON body throws the unreachable message", async () => {
  const broken: FetchLike = async () => ({
    ok: false,
    status: 500,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  });
  await assert.rejects(fetchScores({}, broken), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, SERVER_UNREACHABLE_MESSAGE);
    assert.equal(err.status, 500);
    return true;
  });
});

test("fetchScore requests the encoded id and returns the score", async () => {
  const seen: string[] = [];
  const result = await fetchScore("local:abc", okFetch(sampleScore, seen));
  assert.deepEqual(seen, ["/api/scores/local%3Aabc"]);
  assert.deepEqual(result, sampleScore);
});

test("fetchScore with a 404 throws ApiError with status 404", async () => {
  const notFound: FetchLike = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ error: "not found" }),
  });
  await assert.rejects(fetchScore("local:missing", notFound), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 404);
    return true;
  });
});

test("startDownload POSTs to the download url and returns the job", async () => {
  const seen: [string, unknown][] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 202, json: async () => ({ job: sampleJob }) };
  };
  const job = await startDownload("pdmx:Qm A", fetchFn);
  assert.deepEqual(seen, [["/api/scores/pdmx%3AQm%20A/download", { method: "POST" }]]);
  assert.deepEqual(job, sampleJob);
});

test("removeScore POSTs to the delete url and returns the result", async () => {
  const seen: [string, unknown][] = [];
  const result = { removed: "pdmx:Qm A", kept_in_catalogue: true, message: "Removed X" };
  const fetchFn: FetchLike = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 200, json: async () => result };
  };
  const body = await removeScore("pdmx:Qm A", fetchFn);
  assert.deepEqual(seen, [["/api/scores/pdmx%3AQm%20A/delete", { method: "POST" }]]);
  assert.deepEqual(body, result);
});

test("a 409 from removeScore throws ApiError with status 409 and the message", async () => {
  const busy: FetchLike = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "Another task is running: X. Wait for it to finish." }),
  });
  await assert.rejects(removeScore("pdmx:1", busy), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.message, "Another task is running: X. Wait for it to finish.");
    return true;
  });
});

test("startSetup POSTs to the setup url and returns the job", async () => {
  const seen: [string, unknown][] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 202, json: async () => ({ job: sampleJob }) };
  };
  const job = await startSetup("pdmx", "catalogue", fetchFn);
  assert.deepEqual(seen, [["/api/sources/pdmx/setup/catalogue", { method: "POST" }]]);
  assert.deepEqual(job, sampleJob);
});

test("fetchCurrentJob GETs the current job url with no init", async () => {
  const seen: unknown[][] = [];
  const fetchFn: FetchLike = async (...args) => {
    seen.push(args);
    return { ok: true, status: 200, json: async () => ({ job: sampleJob }) };
  };
  const job = await fetchCurrentJob(fetchFn);
  assert.deepEqual(seen, [["/api/jobs/current"]]);
  assert.deepEqual(job, sampleJob);
});

test("fetchCurrentJob returns null when no job is running", async () => {
  const seen: string[] = [];
  const job = await fetchCurrentJob(okFetch({ job: null }, seen));
  assert.deepEqual(seen, ["/api/jobs/current"]);
  assert.equal(job, null);
});

test("a 409 from startDownload throws ApiError with status 409 and the message", async () => {
  const busy: FetchLike = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: "Another task is running: X. Wait for it to finish." }),
  });
  await assert.rejects(startDownload("pdmx:1", busy), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 409);
    assert.equal(err.message, "Another task is running: X. Wait for it to finish.");
    return true;
  });
});

test("postAttempt POSTs JSON to /api/attempts and returns id and file", async () => {
  const seen: [string, { method: string; headers?: Record<string, string>; body?: string } | undefined][] = [];
  const fetchFn: FetchLike = async (url, init) => {
    seen.push([url, init]);
    return { ok: true, status: 201, json: async () => ({ id: "a1", file: "attempt-a1.json" }) };
  };
  const input = { version: 1, steps: [1, 2] };
  const saved = await postAttempt(input, fetchFn);
  assert.equal(seen[0][0], "/api/attempts");
  assert.equal(seen[0][1]?.method, "POST");
  assert.equal(seen[0][1]?.headers?.["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0][1]?.body ?? ""), input);
  assert.deepEqual(saved, { id: "a1", file: "attempt-a1.json" });
});

test("postAttempt 403 rejects with ApiError carrying the message", async () => {
  const refused: FetchLike = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: "cross-site request refused" }),
  });
  await assert.rejects(postAttempt({}, refused), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, "cross-site request refused");
    assert.equal(err.status, 403);
    return true;
  });
});

test("postAttempt with an unreachable server rejects with the unreachable message", async () => {
  const down: FetchLike = async () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(postAttempt({}, down), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.message, SERVER_UNREACHABLE_MESSAGE);
    return true;
  });
});
