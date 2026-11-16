"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const dist = path.join(__dirname, "..", "dist");

function load(mod) {
  return require(path.join(dist, mod));
}

function testNamingRules() {
  const {
    analyzePublicName,
    getNameDictionary,
    resetNameDictionaryCache,
    suggestCamelName,
    isProperCamelCase,
  } = load("naming_rules.js");

  resetNameDictionaryCache();
  const dict = getNameDictionary();

  assert.ok(!isProperCamelCase("validchange", dict));
  assert.ok(isProperCamelCase("validChange", dict));
  assert.ok(isProperCamelCase("color", dict));

  const seg = suggestCamelName("validchange", dict);
  assert.strictEqual(seg.suggested, "validChange");

  const onOut = analyzePublicName("onClick", "output", dict);
  assert.ok(onOut);
  assert.ok(onOut.violations.some((v) => v.ruleId === "output-no-on-prefix"));
  assert.strictEqual(onOut.suggested, "click");

  const flat = analyzePublicName("validchange", "input", dict);
  assert.ok(flat);
  assert.ok(flat.violations.some((v) => v.ruleId === "camel-case"));
  assert.strictEqual(flat.suggested, "validChange");

  const ok = analyzePublicName("validChange", "input", dict);
  assert.strictEqual(ok, null);

  const okOut = analyzePublicName("valueChange", "output", dict);
  assert.strictEqual(okOut, null);

  console.log("OK: naming rules / dictionary segmentation");
}

function testRenameIoMember() {
  const {
    renameIoMemberInSource,
    hasIoNameCollision,
    parseIoMembers,
  } = load("component_io.js");

  const source = `
@Component({ selector: 'abx-icon' })
export class AbxIconComponent {
  @Input() validchange = false;
  @Output() onClick = new EventEmitter();
  @Input('colorAlias') fillColor: string;
}
`;
  const members = parseIoMembers(source);
  assert.ok(hasIoNameCollision(members, "fillColor"));
  assert.ok(!hasIoNameCollision(members, "validChange"));

  const renamedFlat = renameIoMemberInSource(source, {
    kind: "input",
    publicName: "validchange",
    propertyName: "validchange",
    newPublicName: "validChange",
  });
  assert.ok(!("error" in renamedFlat));
  assert.ok(renamedFlat.source.includes("@Input() validChange"));
  assert.ok(!renamedFlat.source.includes("@Input() validchange"));

  const renamedOut = renameIoMemberInSource(source, {
    kind: "output",
    publicName: "onClick",
    propertyName: "onClick",
    newPublicName: "click",
  });
  assert.ok(!("error" in renamedOut));
  assert.ok(renamedOut.source.includes("@Output() click"));

  const renamedAlias = renameIoMemberInSource(source, {
    kind: "input",
    publicName: "colorAlias",
    propertyName: "fillColor",
    newPublicName: "foregroundColor",
  });
  assert.ok(!("error" in renamedAlias));
  assert.ok(renamedAlias.source.includes("@Input('foregroundColor')"));
  assert.ok(renamedAlias.source.includes("fillColor"));

  console.log("OK: TypeScript @Input/@Output rename helper");
}

function testCustomDictFile() {
  const {
    getNameDictionary,
    resetNameDictionaryCache,
    suggestCamelName,
  } = load("naming_rules.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ngpilot-dict-"));
  const dictPath = path.join(tmp, "extra.txt");
  fs.writeFileSync(dictPath, "# custom\nfoobar\nbazqux\n", "utf8");

  resetNameDictionaryCache();
  const dict = getNameDictionary([dictPath]);
  assert.ok(dict.has("foobar"));
  assert.ok(dict.has("bazqux"));
  const sug = suggestCamelName("foobarbazqux", dict);
  assert.strictEqual(sug.suggested, "foobarBazqux");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("OK: custom name dictionary file");
}

function testFormatLogAndSummary() {
  const { formatFixIoNamesLog, printFixIoNamesControlsHelp } = load(
    "fix_io_names.js"
  );
  printFixIoNamesControlsHelp();
  const text = formatFixIoNamesLog(
    [
      {
        repoName: "components-base-v1",
        repoRoot: "D:/x",
        filePath: "D:/x/abx-icon.ts",
        className: "AbxIconComponent",
        selector: "abx-icon",
        skipped: false,
        violations: [
          {
            kind: "output",
            publicName: "onClick",
            propertyName: "onClick",
            suggested: "click",
            rules: ["output-no-on-prefix"],
            skipAction: "nc",
          },
          {
            kind: "input",
            publicName: "validchange",
            propertyName: "validchange",
            suggested: "validChange",
            chosen: "validChange",
            rules: ["camel-case"],
            renamed: true,
          },
        ],
      },
    ],
    {
      componentsScanned: 1,
      componentsSkipped: 0,
      attributesChecked: 2,
      violationsFound: 2,
      renamed: 1,
      skippedByUser: 0,
      skippedViaNc: 1,
      skippedViaNr: 0,
      quitMidRun: false,
      tsRenameWarnings: 0,
      affectedRepos: ["components-base-v1"],
      changeRunHashes: ["abc123"],
      changeRunHashInfos: [
        { hash: "abc123", runFile: "D:/logs/runs/abc123.json" },
      ],
      renamedAttributes: [
        {
          repoName: "components-base-v1",
          className: "AbxIconComponent",
          selector: "abx-icon",
          kind: "input",
          fromName: "validchange",
          toName: "validChange",
          filePath: "D:/x/abx-icon.ts",
          changeRunHash: "abc123",
        },
      ],
      tsFailures: [],
      stoppedAt: {
        timestamp: "2026-01-01T00:00:00.000Z",
        reason: "completed",
      },
      impactJsonPath: undefined,
      impactCsvPath: undefined,
      nameDictFiles: [],
    }
  );
  assert.ok(text.includes("VIOLATION") || text.includes("onClick"));
  assert.ok(text.includes("SKIP_NC") || text.includes("skipAction=nc") || text.includes("nc"));
  assert.ok(text.includes("validchange"));
  assert.ok(text.includes("validChange"));
  assert.ok(text.includes("renamed: 1") || text.includes("Renamed attributes"));
  console.log("OK: fix-io-names log formatting");
}

function testHelp() {
  const bin = path.join(dist, "angular_io_tool.js");
  const help = spawnSync(process.execPath, [bin, "fix-io-names", "--help"], {
    encoding: "utf8",
  });
  assert.strictEqual(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes("fix-io-names"));
  assert.ok(help.stdout.includes("name-dict") || help.stdout.includes("NGPILOT_NAME_DICT"));
  const root = spawnSync(process.execPath, [bin, "--help"], {
    encoding: "utf8",
  });
  assert.ok(root.stdout.includes("fix-io-names"));
  console.log("OK: fix-io-names help");
}

function testBuiltinWordFileCopied() {
  const copied = path.join(dist, "data", "name-words.txt");
  assert.ok(fs.existsSync(copied), "dist/data/name-words.txt missing (copy-data)");
  const text = fs.readFileSync(copied, "utf8");
  assert.ok(text.includes("valid"));
  assert.ok(text.includes("change"));
  console.log("OK: built-in name-words.txt shipped to dist/data");
}

function main() {
  testNamingRules();
  testRenameIoMember();
  testCustomDictFile();
  testFormatLogAndSummary();
  testBuiltinWordFileCopied();
  testHelp();
  console.log("\nAll fix-io-names tests passed.");
}

main();
