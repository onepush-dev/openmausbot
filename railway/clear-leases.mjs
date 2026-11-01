// Railway mounts a service's volume into one container at a time (the old
// deployment stops before the new one starts), so a data-directory lease that
// another container wrote can never belong to a live process here. Remove those
// records before the server starts, exactly as upstream's Cloud home launcher
// does for its own volumes (server/cloud-home-start.ts, clearRecordsFromOtherMachines).
// Records from this container are left for the server's own dead-owner recovery.
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";

const dataDir = process.env.OMB_DATA_DIR || "/data/.openmausbot";
const LEASE = "openmausbot-server.lease";
let entries = [];
try { entries = readdirSync(dataDir); } catch { process.exit(0); }
const paths = [
  join(dataDir, LEASE),
  join(dataDir, ".openmausbot-server-child", LEASE),
  ...entries.filter((n) => n.startsWith(`${LEASE}.reap-`)).map((n) => join(dataDir, n)),
];
for (const path of paths) {
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
  if (!record || record.host === hostname()) continue;
  unlinkSync(path);
  console.log(`[railway] cleared a stale data-directory lease left by container ${record.host} (pid ${record.pid}): ${path}`);
}
