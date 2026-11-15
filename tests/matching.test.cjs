const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

// Exercise the shipped content script without starting its DOM observer.
const source = fs.readFileSync(path.join(__dirname, "../content.js"), "utf8");
const context = vm.createContext({});
vm.runInContext(source.replace(/  init\(\);\s*\}\)\(\);\s*$/, "  globalThis.api = { matchProfessor, injectRating };\n})();"), context);
const { matchProfessor, injectRating } = context.api;
const professor = (firstName, lastName, numRatings = 10, classes = ["MATH171"]) => ({ firstName, lastName, numRatings, legacyId: 123, avgRating: 4, avgDifficulty: 2, ratings: { edges: classes.map(label => ({ node: { class: label } })) } });
const match = (nodes, name, course = { dept: "MATH", number: "171" }) => matchProfessor({ edges: nodes.map(node => ({ node })) }, name, course);

test("unrelated popular professors are never a fallback", () => {
  assert.equal(match([professor("Alice", "Jones", 999)], "Smith, Bob"), null);
  assert.equal(match([professor("Alice", "Smith", 999)], "Smith, Bob"), null);
});

test("an exact name wins over a more popular approximation", () => {
  const result = match([professor("Jo", "Smith", 999), professor("John", "Smith")], "Smith, John");
  assert.equal(result.firstName, "John");
  assert.equal(result.matchWarning, "");
});

test("middle-name differences and prefix matches require verification", () => {
  assert.ok(match([professor("John", "Smith")], "Smith, John T.").matchWarning);
  assert.ok(match([professor("John", "Smith")], "Smith, J.").matchWarning);
});

test("duplicate exact profiles are marked ambiguous", () => {
  assert.ok(match([professor("John", "Smith"), professor("John", "Smith", 20)], "John Smith").matchWarning);
});

test("missing names and empty results do not select a profile", () => {
  assert.equal(match([], "John Smith"), null);
  assert.equal(match([professor("", "Smith")], "John Smith"), null);
  assert.equal(match([professor("John", "Smith")], ""), null);
});

test("course subject disambiguates otherwise identical names", () => {
  const math = professor("John", "Smith", 10, ["MATH171"]);
  const history = professor("John", "Smith", 999, ["HIST105"]);
  assert.equal(match([history, math], "John Smith").numRatings, 10);
  assert.equal(match([history, math], "John Smith").matchWarning, "");
  assert.equal(match([history, math], "John Smith", { dept: "HIST" }).numRatings, 999);
});

test("course formatting supports spaces, hyphens and case", () => {
  for (const label of ["MATH171", "math 171", "MATH-171", " MATH "]) {
    assert.equal(match([professor("John", "Smith", 10, [label])], "John Smith").matchWarning, "");
  }
});

test("missing or different course subjects always require verification", () => {
  for (const classes of [[], [null], ["HIST105"], ["MATHH171"], ["171"]]) {
    assert.match(match([professor("John", "Smith", 10, classes)], "John Smith").matchWarning, /No MATH course/);
  }
  const noReviews = { ...professor("John", "Smith"), ratings: undefined, department: "Mathematics" };
  assert.match(match([noReviews], "John Smith").matchWarning, /sampled/);
  assert.match(match([professor("John", "Smith")], "John Smith", null).matchWarning, /could not be determined/);
});

test("matching subjects never rescue an unrelated name or hide an approximate name", () => {
  assert.equal(match([professor("Jane", "Jones")], "John Smith"), null);
  assert.match(match([professor("John", "Smith")], "J Smith").matchWarning, /approximate/);
});

function element() {
  return { style: {}, dataset: {}, children: [], appendChild(child) { this.children.push(child); }, querySelector() { return null; } };
}

test("approximate matches show a warning beside the profile link", () => {
  context.document = { createElement: element };
  const el = element();
  injectRating(el, match([professor("John", "Smith")], "J Smith"));
  const badge = el.children[0];
  assert.ok(badge.children.some(child => child.className === "rmp-link"));
  const warning = badge.children.find(child => child.className === "rmp-match-warning");
  assert.match(warning.textContent, /Verify RMP match/);
  assert.match(warning.title, /approximate/);
});
