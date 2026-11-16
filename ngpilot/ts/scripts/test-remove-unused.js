"use strict";

const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");

const dist = path.join(__dirname, "..", "dist");

function load(mod) {
  return require(path.join(dist, mod));
}

function testParseIoMembers() {
  const { parseIoMembers, removeIoMemberFromSource, resolveComponentSelector } =
    load("component_io.js");

  const source = `
const $COMPONENT_NAME = 'abx-icon';
@Component({
  selector: $COMPONENT_NAME,
  templateUrl: './abx-icon.html',
})
export class AbxIconComponent {
  @Input() isCustomIcon = false;
  @Input('colorAlias') fillColor: string;
  @Output() iconClick = new EventEmitter();
  @Input() set size(v: string) { this._size = v; }
}
`;
  assert.strictEqual(resolveComponentSelector(source), "abx-icon");
  const members = parseIoMembers(source);
  assert.ok(members.some((m) => m.kind === "input" && m.publicName === "isCustomIcon"));
  assert.ok(
    members.some(
      (m) =>
        m.kind === "input" &&
        m.publicName === "colorAlias" &&
        m.propertyName === "fillColor"
    )
  );
  assert.ok(members.some((m) => m.kind === "output" && m.publicName === "iconClick"));
  assert.ok(
    members.some((m) => m.kind === "input" && m.publicName === "size" && m.isSetter)
  );

  const removed = removeIoMemberFromSource(source, "input", "colorAlias", "fillColor");
  assert.ok(!("error" in removed));
  assert.ok(!removed.source.includes("colorAlias"));
  assert.ok(removed.source.includes("isCustomIcon"));
  console.log("OK: parse/remove @Input/@Output members");
}

function testHelp() {
  const bin = path.join(dist, "angular_io_tool.js");
  const help = spawnSync(process.execPath, [bin, "remove-unused", "--help"], {
    encoding: "utf8",
  });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("remove-unused"));
  const commitHelp = spawnSync(process.execPath, [bin, "commit", "--help"], {
    encoding: "utf8",
  });
  assert.ok(commitHelp.stdout.includes("hashes"));
  console.log("OK: remove-unused and multi-hash commit help");
}

function testFormatLogAndSummary() {
  const { formatRemoveUnusedLog, printRemoveUnusedControlsHelp } = load(
    "remove_unused.js"
  );
  printRemoveUnusedControlsHelp();
  const text = formatRemoveUnusedLog(
    [
      {
        repoName: "components-base-v1",
        repoRoot: "D:/x",
        filePath: "D:/x/abx-icon.ts",
        className: "AbxIconComponent",
        selector: "abx-icon",
        skipped: false,
        attributes: [
          {
            kind: "input",
            publicName: "isUtilityIcon",
            propertyName: "isUtilityIcon",
            bindingHits: 0,
            tagCount: 0,
            fileCount: 0,
            repoCount: 0,
            repos: [],
            files: [],
            skipAction: "nc",
          },
        ],
      },
    ],
    {
      componentsScanned: 1,
      componentsSkipped: 0,
      attributesChecked: 1,
      unusedFound: 1,
      removed: 0,
      skippedByUser: 0,
      skippedViaNc: 1,
      skippedViaNr: 0,
      quitMidRun: true,
      tsRemovalWarnings: 0,
      affectedRepos: [],
      changeRunHashes: ["abc123"],
      changeRunHashInfos: [
        { hash: "abc123", runFile: "D:/logs/runs/abc123.json" },
      ],
      removedAttributes: [],
      stoppedAt: {
        timestamp: "2026-01-01T00:00:00.000Z",
        repoName: "components-base-v1",
        className: "AbxIconComponent",
        selector: "abx-icon",
        attribute: "isUtilityIcon",
        reason: "quit",
      },
      impactJsonPath: undefined,
      impactCsvPath: undefined,
    }
  );
  assert.ok(text.includes("UNUSED"));
  assert.ok(text.includes("SKIP_NC"));
  assert.ok(text.includes("quitMidRun: true"));
  assert.ok(text.includes("isUtilityIcon"));
  console.log("OK: remove-unused log formatting with NC/Q fields");
}

function main() {
  testParseIoMembers();
  testFormatLogAndSummary();
  testHelp();
  console.log("\nAll remove-unused tests passed.");
}

main();
