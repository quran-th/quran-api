export const DEFAULT_CONTRIBUTE_URL = "https://contribute.quran.in.th";
const TIMEOUT_MS = 15000;

export class ReleaseIndexError extends Error {}

/** Connection settings from the environment; nothing here is ever printed. */
export function releaseIndexConfig(env = process.env) {
  return {
    baseUrl: (env.CONTRIBUTE_URL || DEFAULT_CONTRIBUTE_URL).replace(/\/+$/, ""),
    releaseKey: env.RELEASE_KEY || "",
    token: env.CONTRIBUTE_TOKEN || "",
  };
}

function headersFor(method, { releaseKey, token }) {
  const headers = { Accept: "application/json" };
  // GET routes need an admin JWT; the release key is only accepted by the two PUT routes.
  const preferKey = method !== "GET";
  if (preferKey && releaseKey) headers["X-Release-Key"] = releaseKey;
  else if (token) headers.Authorization = `Bearer ${token}`;
  else if (releaseKey) headers["X-Release-Key"] = releaseKey;
  return headers;
}

async function request(
  method,
  path,
  body,
  {
    config = releaseIndexConfig(),
    fetchImpl = fetch,
    timeoutMs = TIMEOUT_MS,
  } = {},
) {
  const headers = headersFor(method, config);
  if (!headers.Authorization && !headers["X-Release-Key"])
    throw new ReleaseIndexError(
      "release index: set CONTRIBUTE_TOKEN (reads) or RELEASE_KEY (writes)",
    );
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${config.baseUrl}${path}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ReleaseIndexError(
      `release index: ${method} ${path} ${error.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : `failed: ${error.message}`}`,
    );
  }
  if (response.status >= 300 && response.status < 400)
    throw new ReleaseIndexError(
      `release index: ${method} ${path} answered a redirect (${response.status}); refusing to follow it`,
    );
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const hint =
      method === "GET" && (response.status === 401 || response.status === 403)
        ? "; reading needs an admin JWT in CONTRIBUTE_TOKEN (RELEASE_KEY only works for writes)"
        : "";
    const message = payload?.error?.message ?? payload?.error ?? "";
    throw new ReleaseIndexError(
      `release index: ${method} ${path} answered ${response.status}${message ? ` (${typeof message === "string" ? message : JSON.stringify(message)})` : ""}${hint}`,
    );
  }
  if (payload?.data === undefined)
    throw new ReleaseIndexError(
      `release index: ${method} ${path} returned an unexpected body`,
    );
  return payload.data;
}

const versionPath = (version) => `/api/releases/${encodeURIComponent(version)}`;

/** @returns {Promise<{ release: object, steps: object[], verses: object[] }>} */
export const getRelease = (version, options) =>
  request("GET", versionPath(version), undefined, options);

/** @returns {Promise<{ tags: object[] }>} proofing decisions grouped by tag */
export const getReleaseTags = (version, options) =>
  request("GET", `${versionPath(version)}/tags`, undefined, options);

export const putStep = (version, step, status, detail, options) =>
  request(
    "PUT",
    `${versionPath(version)}/steps/${encodeURIComponent(step)}`,
    detail ? { status, detail: String(detail).slice(0, 2000) } : { status },
    options,
  );

export const putVerses = (version, verses, options) =>
  request("PUT", `${versionPath(version)}/verses`, { verses }, options);

/** Reporting is best-effort: a failure prints a warning and never throws. */
export async function reportStep(version, step, status, detail, options) {
  try {
    await putStep(version, step, status, detail, options);
  } catch (error) {
    console.warn(
      `warning: could not report ${step} ${status}: ${error.message}`,
    );
  }
}
