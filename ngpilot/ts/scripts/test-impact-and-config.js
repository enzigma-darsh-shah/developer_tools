"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");

function load(mod) {
  return require(path.join(dist, mod));
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function testUuidV7() {
  const { uuidv7 } = load("uuidv7.js");
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  const a = uuidv7();
  const b = uuidv7();
  assert.notStrictEqual(a, b);
  console.log("OK: uuidv7");
}

function testPairImpactPaths() {
  const { pairImpactLogPaths } = load("paths.js");
  const csv = pairImpactLogPaths("D:/folder/nested/their_file_name.csv");
  assert.strictEqual(
    path.normalize(csv.csvPath).toLowerCase(),
    path.normalize("D:/folder/nested/their_file_name.csv").toLowerCase()
  );
  assert.strictEqual(
    path.normalize(csv.jsonPath).toLowerCase(),
    path.normalize("D:/folder/nested/their_file_name.json").toLowerCase()
  );
  const json = pairImpactLogPaths("D:/folder/nested/their_file_name.json");
  assert.strictEqual(
    path.normalize(json.csvPath).toLowerCase(),
    path.normalize("D:/folder/nested/their_file_name.csv").toLowerCase()
  );
  console.log("OK: impact path pairing");
}

function testComponentSelector() {
  const { resolveComponentAffected, extractSelectorFromTs } = load(
    "component_selector.js"
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngpilot-comp-"));
  try {
    const html = path.join(tmp, "abx-table.html");
    const ts = path.join(tmp, "abx-table.ts");
    fs.writeFileSync(html, "<abx-icon [fillColor]=\"'red'\"></abx-icon>\n", "utf8");
    fs.writeFileSync(
      ts,
      [
        "const $COMPONENT_NAME: string = 'abx-table';",
        "@Component({",
        "    selector: $COMPONENT_NAME,",
        "    templateUrl: './abx-table.html',",
        "    styleUrls: ['./abx-table.css']",
        "})",
        "export class AbxTable {}",
        "",
      ].join("\n"),
      "utf8"
    );
    assert.strictEqual(resolveComponentAffected(html), "abx-table");

    const literal = extractSelectorFromTs(
      `@Component({ selector: 'abx-icon', templateUrl: './x.html' })`
    );
    assert.strictEqual(literal, "abx-icon");

    const orphanHtml = path.join(tmp, "orphan-widget.html");
    fs.writeFileSync(orphanHtml, "<div></div>\n", "utf8");
    assert.strictEqual(resolveComponentAffected(orphanHtml), "orphan-widget");
    console.log("OK: component selector resolution");
  } finally {
    rmrf(tmp);
  }
}

function testImpactAppend() {
  const { appendImpactRecords, buildImpactRecords } = load("impact.js");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngpilot-impact-"));
  try {
    const csvPath = path.join(tmp, "components_impact_area.csv");
    const records = buildImpactRecords({
      githubUserName: "test-user",
      selector: "abx-icon",
      operation: "rename",
      changes: [
        {
          filePath: path.join(tmp, "abx-table.html"),
          repo: "components-base-v1",
          line: 10,
          attributeAffected: "fillColor",
          notes: "Renamed fillColor to foregroundColor",
        },
        {
          filePath: path.join(tmp, "abx-table.html"),
          repo: "components-base-v1",
          line: 10,
          attributeAffected: "isCustomIcon",
          notes: "Renamed isCustomIcon to isCustom",
        },
      ],
    });
    assert.strictEqual(records.length, 2);
    assert.notStrictEqual(records[0].id, records[1].id);

    const written = appendImpactRecords(records, csvPath);
    assert.ok(fs.existsSync(written.csvPath));
    assert.ok(fs.existsSync(written.jsonPath));
    const csv = fs.readFileSync(written.csvPath, "utf8");
    assert.ok(csv.includes("github-user-name"));
    assert.ok(csv.includes("fillColor"));
    assert.ok(csv.includes("isCustomIcon"));
    const json = JSON.parse(fs.readFileSync(written.jsonPath, "utf8"));
    assert.strictEqual(json.length, 2);
    console.log("OK: impact JSON/CSV append (2 rows same line)");
  } finally {
    rmrf(tmp);
  }
}

function testHelpMentionsEnv() {
  const bin = path.join(dist, "angular_io_tool.js");
  for (const args of [["--help"], ["rename", "--help"], ["remove", "--help"]]) {
    const result = spawnSync(process.execPath, [bin, ...args], {
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(
      result.stdout.includes("NGPILOT_ROOTS"),
      `missing NGPILOT_ROOTS in ${args.join(" ")}`
    );
    assert.ok(
      result.stdout.includes("NGPILOT_IMPACT_LOG"),
      `missing NGPILOT_IMPACT_LOG in ${args.join(" ")}`
    );
  }
  const renameHelp = spawnSync(process.execPath, [bin, "rename", "--help"], {
    encoding: "utf8",
  });
  assert.ok(renameHelp.stdout.includes("--impact-log"));
  assert.ok(renameHelp.stdout.includes("--logs-dir"));
  assert.ok(renameHelp.stdout.includes("--runs-dir"));
  console.log("OK: help documents env + impact flags");
}

function main() {
  testUuidV7();
  testPairImpactPaths();
  testComponentSelector();
  testImpactAppend();
  testHelpMentionsEnv();
  console.log("\nAll impact/config tests passed.");
}

main();
