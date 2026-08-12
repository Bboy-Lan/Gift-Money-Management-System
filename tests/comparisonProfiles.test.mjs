import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadComparisonProfiles() {
  const source = await readFile(new URL("../src/lib/comparisonProfiles.ts", import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function person(vaultPath, vaultName, personId, displayName, address, notes = null, tags = []) {
  return { vaultPath, vaultName, personId, displayName, address, notes, tags };
}

function history(vaultPath, vaultName, personId, personName, bookId, totalFen, latestReceivedAt, { address = null, notes = null, tags = [], paymentMethod = "现金" } = {}) {
  return { vaultPath, vaultName, personId, personName, personAddress: address, personNotes: notes, tags, bookId, bookTitle: bookId, eventDate: null, giftCount: 1, totalFen, paymentMethod, note: null, returnGift: null, latestReceivedAt };
}

test("same names from different vaults remain separate while preserving identity judgment", async () => {
  const { buildComparisonProfiles } = await loadComparisonProfiles();
  const profiles = buildComparisonProfiles(
    [
      person("D:/a.giftvault", "礼金库 A", "a-liu", "刘洋", "昆明", "同学"),
      person("D:/b.giftvault", "礼金库 B", "b-liu", "刘洋", "玉溪", "同事"),
    ],
    [
      history("D:/a.giftvault", "礼金库 A", "a-liu", "刘洋", "a-book", 80_000, "2025-01-02", { address: "昆明", notes: "同学" }),
      history("D:/b.giftvault", "礼金库 B", "b-liu", "刘洋", "b-book", 100_000, "2025-02-02", { address: "玉溪", notes: "同事" }),
    ],
  );

  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((profile) => profile.person.vaultPath), ["D:/a.giftvault", "D:/b.giftvault"]);
  assert.ok(profiles.every((profile) => profile.person.displayName === "刘洋"));
  assert.ok(profiles.every((profile) => profile.members.length === 1));
  assert.ok(profiles.every((profile) => profile.history.length === 1));
  assert.ok(profiles.every((profile) => profile.identityAssessment?.status === "review"));
});

test("matching identity fields are marked while different vault records remain visible", async () => {
  const { buildComparisonProfiles } = await loadComparisonProfiles();
  const tag = [{ id: "tag", name: "老乡", color: "#b42318" }];
  const profiles = buildComparisonProfiles(
    [
      person("D:/a.giftvault", "A", "a-liu", "刘洋", "昆明市呈贡区", "大学同学", tag),
      person("D:/b.giftvault", "B", "b-liu", "刘洋", "昆明市呈贡区", "大学同学", tag),
    ],
    [
      history("D:/a.giftvault", "A", "a-liu", "刘洋", "a-book", 80_000, "2025-01-01", { address: "昆明市呈贡区", notes: "大学同学", tags: tag }),
      history("D:/b.giftvault", "B", "b-liu", "刘洋", "b-book", 100_000, "2025-02-01", { address: "昆明市呈贡区", notes: "大学同学", tags: tag }),
    ],
  );

  assert.equal(profiles.length, 2);
  assert.ok(profiles.every((profile) => profile.members.length === 1));
  assert.ok(profiles.every((profile) => profile.identityAssessment?.status === "same"));
  assert.ok(profiles.every((profile) => profile.identityAssessment?.label === "同一人"));
});

test("same-name people in one vault remain separate identities", async () => {
  const { buildComparisonProfiles } = await loadComparisonProfiles();
  const profiles = buildComparisonProfiles(
    [
      person("D:/same.giftvault", "同一礼金库", "person-a", "刘洋", "昆明"),
      person("D:/same.giftvault", "同一礼金库", "person-b", "刘洋", "玉溪"),
    ],
    [
      history("D:/same.giftvault", "同一礼金库", "person-a", "刘洋", "book-a", 100, "2025-01-01", { address: "昆明" }),
      history("D:/same.giftvault", "同一礼金库", "person-b", "刘洋", "book-a", 200, "2025-01-02", { address: "玉溪" }),
    ],
  );

  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.map((profile) => profile.person.personId), ["person-a", "person-b"]);
  assert.ok(profiles.every((profile) => profile.identityAssessment?.status === "review"));
});

test("one original person in several selected books remains one group with an average in integer fen", async () => {
  const { buildComparisonProfiles } = await loadComparisonProfiles();
  const [profile] = buildComparisonProfiles(
    [person("D:/books.giftvault", "多本礼金簿", "liu", "刘洋", "昆明")],
    [
      history("D:/books.giftvault", "多本礼金簿", "liu", "刘洋", "book-a", 100, "2025-01-01"),
      history("D:/books.giftvault", "多本礼金簿", "liu", "刘洋", "book-b", 101, "2025-01-02"),
    ],
  );

  assert.equal(profile.members.length, 1);
  assert.equal(profile.averageFen, 101);
  assert.equal(profile.identityAssessment.status, "same");
});

test("a name without another matching record has no identity judgment", async () => {
  const { buildComparisonProfiles } = await loadComparisonProfiles();
  const [profile] = buildComparisonProfiles([person("D:/a.giftvault", "A", "chen", "陈晨", "昆明")], []);
  assert.equal(profile.identityAssessment, null);
});
