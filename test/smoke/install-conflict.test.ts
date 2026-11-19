import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repo = fileURLToPath(new URL("../../", import.meta.url));

async function makeCopy(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await cp(join(repo, "package.json"), join(dir, "package.json"));
  await cp(join(repo, "src"), join(dir, "src"), { recursive: true });
  await symlink(join(repo, "node_modules"), join(dir, "node_modules"));
  return dir;
}

for (const scope of ["global", "project", "both", "after-trust"] as const) {
  test(`Две независимые копии пакета, Pi загружает одну: ${scope}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "goal-compact-install-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir);
    if (scope !== "project") {
      const global = await makeCopy(join(root, "packages", "pi-goal-compact"));
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [global] }));
    }
    if (scope !== "global") {
      const project = await makeCopy(join(cwd, ".agents", "plugins", "pi-goal-compact"));
      await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [project] }));
    }
    const settingsManager = SettingsManager.create(cwd, agentDir);
    settingsManager.setProjectTrusted(scope !== "after-trust");
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noContextFiles: true });
    await loader.reload(scope === "after-trust" ? { resolveProjectTrust: async () => true } : undefined);
    const result = loader.getExtensions();
    const copies = result.extensions.filter(extension => extension.path.endsWith("pi-goal-compact/src/index.ts"));
    assert.equal(copies.length, scope === "global" || scope === "project" ? 1 : 2);
    assert.deepEqual(result.errors, []);
    const owners = copies.filter(extension => extension.tools.has("create_goal"));
    assert.equal(owners.length, 1);
    const [owner] = owners;
    assert.ok(owner);
    assert.ok(owner.commands.has("context"));
    assert.ok(owner.handlers.has("session_start"));
    for (const copy of copies.filter(extension => extension !== owner)) {
      assert.equal(copy.tools.size + copy.commands.size + copy.handlers.size + (copy.entryRenderers?.size ?? 0), 0);
    }
    if (scope === "after-trust") assert.match(owner.path, /\/packages\/pi-goal-compact\//);
    if (scope === "both") {
      result.runtime.invalidate();
      await loader.reload();
      const reloaded = loader.getExtensions();
      assert.deepEqual(reloaded.errors, []);
      assert.equal(reloaded.extensions.filter(extension => extension.tools.has("create_goal")).length, 1);
    }
  });
}
