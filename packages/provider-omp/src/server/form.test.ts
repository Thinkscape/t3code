import { assert, it } from "@effect/vitest";
import { ompFormCard, ompFormQuestion, ompFormSubmission, type OmpFormCard } from "./form.ts";

function cardOf(html: string): OmpFormCard {
  const card = ompFormCard(html);
  if ("unsupported" in card) return assert.fail(card.unsupported);
  return card;
}

function questionsOf(card: OmpFormCard) {
  return card.entries.map((entry) => ompFormQuestion(entry));
}

const STORE_FORM = `<form>
  <p>Sessions live in memory and are lost on <code>restart</code>.</p>
  <table><tr><th>Store</th><th>Ops</th></tr><tr><td>SQLite</td><td>none</td></tr></table>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite" checked> SQLite</label>
    <label><input type="radio" name="store" value="redis"> Redis</label>
  </fieldset>
</form>`;

it("asks a radio group with its preselected option as the recommendation and context as markdown", () => {
  const card = cardOf(STORE_FORM);
  const [store] = questionsOf(card);
  assert.equal(card.title, "Session store");
  assert.equal(store?.id, "store");
  assert.isUndefined(store?.multiSelect);
  // A radio group of two or more options takes an "Other" answer.
  assert.isTrue(store?.allowCustomAnswer);
  assert.deepEqual(store?.options, [
    { label: "SQLite", description: "Recommended", value: "sqlite" },
    { label: "Redis", description: "Redis", value: "redis" },
  ]);
  assert.equal(
    store?.question,
    [
      "Sessions live in memory and are lost on `restart`.",
      "| Store | Ops |\n| --- | --- |\n| SQLite | none |",
      "**Session store**",
    ].join("\n\n"),
  );
  assert.deepEqual(ompFormSubmission(card, card.entries, { store: "redis" }, new Map()), {
    data: { store: "redis" },
  });
  // Typed text that names an option picks it; any other text is the Other answer.
  assert.deepEqual(ompFormSubmission(card, card.entries, { store: "SQLite" }, new Map()), {
    data: { store: "sqlite" },
  });
  assert.deepEqual(ompFormSubmission(card, card.entries, { store: "DuckDB" }, new Map()), {
    data: { store: "DuckDB" },
  });
});

it("asks a checkbox group as a multi-select with None and Other", () => {
  const card = cardOf(`<form><p>Which platforms?</p>
    <label><input type="checkbox" name="platforms" value="web" checked> Web</label>
    <label><input type="checkbox" name="platforms" value="ios"> iOS</label>
  </form>`);
  const [platforms] = questionsOf(card);
  assert.equal(platforms?.question, "Which platforms?");
  assert.isTrue(platforms?.multiSelect);
  assert.isTrue(platforms?.allowCustomAnswer);
  const none = platforms?.options.at(-1)?.value;
  assert.deepEqual(
    platforms?.options.map((option) => option.label),
    ["Web", "iOS", "None"],
  );
  const submit = (answer: unknown) =>
    ompFormSubmission(card, card.entries, { platforms: answer }, new Map());
  assert.deepEqual(submit(["ios", "web"]), { data: { platforms: ["web", "ios"] } });
  assert.deepEqual(submit(["ios", "Android"]), { data: { platforms: ["ios", "Android"] } });
  // The card sends typed text alone; it may still name options beside the Other answer.
  assert.deepEqual(submit("Web, Android"), { data: { platforms: ["web", "Android"] } });
  assert.deepEqual(submit([none]), { data: { platforms: [] } });
});

it("rejects free text for a group that already has its own Other option", () => {
  const card = cardOf(`<form><p>Pick</p>
    <label><input type="radio" name="pick" value="a"> A</label>
    <label><input type="radio" name="pick" value="other"> Other</label>
  </form>`);
  const [pick] = questionsOf(card);
  assert.isFalse(pick?.allowCustomAnswer);
  // Optional and nothing preselected: the card offers an explicit "No answer".
  assert.equal(pick?.options.at(-1)?.label, "No answer");
  const result = ompFormSubmission(card, card.entries, { pick: "Banana" }, new Map());
  assert.isTrue("problems" in result && result.problems[0]?.message === "Pick one of the options");
  assert.deepEqual(
    ompFormSubmission(card, card.entries, { pick: pick?.options.at(-1)?.value }, new Map()),
    { data: {} },
  );
});

it("enforces required text and keeps accepted answers across a retry", () => {
  const card = cardOf(`<form>
    <label><input type="radio" name="tier" value="free" checked> Free</label>
    <label><input type="radio" name="tier" value="pro"> Pro</label>
    <label>Project name <input type="text" name="project" required minlength="3"></label>
  </form>`);
  const [, project] = questionsOf(card);
  assert.isTrue(project?.required);
  assert.isEmpty(project?.options ?? ["missing"]);
  assert.include(project?.question ?? "", "*At least 3 characters*");
  const first = ompFormSubmission(card, card.entries, { tier: "pro", project: "  " }, new Map());
  if (!("problems" in first)) return assert.fail("expected a problem");
  assert.deepEqual(
    first.problems.map((problem) => [problem.entry.id, problem.message]),
    [["project", "An answer is required"]],
  );
  const retried = ompFormQuestion(first.problems[0]!.entry, first.problems[0]);
  assert.match(retried.question, /^\*\*An answer is required\.\*\*/);
  const short = ompFormSubmission(
    card,
    [first.problems[0]!.entry],
    { project: "ab" },
    first.accepted,
  );
  assert.isTrue(
    "problems" in short && short.problems[0]?.message === "Needs at least 3 characters",
  );
  assert.deepEqual(
    ompFormSubmission(card, [first.problems[0]!.entry], { project: "demo" }, first.accepted),
    { data: { tier: "pro", project: "demo" } },
  );
});

it("coerces number fields and enforces min and max", () => {
  const card = cardOf(
    `<form><label>Session lifetime (days) <input type="number" name="ttl" value="30" min="1" max="90"></label></form>`,
  );
  const [ttl] = questionsOf(card);
  assert.equal(ttl?.initialAnswer, "30");
  assert.isFalse(ttl?.required);
  assert.include(ttl?.question ?? "", "*A number, from 1 to 90, optional*");
  const submit = (answer: string) =>
    ompFormSubmission(card, card.entries, { ttl: answer }, new Map());
  assert.deepEqual(submit("14"), { data: { ttl: 14 } });
  assert.deepEqual(submit(""), { data: { ttl: "" } });
  for (const [answer, message] of [
    ["0", "Must be at least 1"],
    ["120", "Must be at most 90"],
    ["soon", "Enter a number"],
  ] as const) {
    const result = submit(answer);
    assert.isTrue("problems" in result && result.problems[0]?.message === message, answer);
  }
});

it("checks email, url and pattern fields as omp does", () => {
  const card = cardOf(`<form>
    <label>Email <input type="email" name="email"></label>
    <label>Site <input type="url" name="site"></label>
    <label>Code <input name="code" pattern="[A-Z]{3}"></label>
  </form>`);
  const bad = ompFormSubmission(
    card,
    card.entries,
    { email: "nope", site: "example.com", code: "abcd" },
    new Map(),
  );
  if (!("problems" in bad)) return assert.fail("expected problems");
  assert.deepEqual(
    bad.problems.map((problem) => problem.message),
    ["Enter an email address", "Enter a full URL", "Must match the pattern [A-Z]{3}"],
  );
  assert.deepEqual(
    ompFormSubmission(
      card,
      card.entries,
      { email: "a@b.c", site: "https://example.com", code: "ABC" },
      new Map(),
    ),
    { data: { email: "a@b.c", site: "https://example.com", code: "ABC" } },
  );
});

it("keeps hidden inputs, asks a lone checkbox as yes or no and a select as one choice", () => {
  const card = cardOf(`<form>
    <input type="hidden" name="version" value="2">
    <label><input type="checkbox" name="tests" value="yes" checked> Add tests</label>
    <label>Region <select name="region"><option>us</option><option selected>eu</option></select></label>
    <label>Notes <textarea name="notes"></textarea></label>
  </form>`);
  const [tests, region, notes] = questionsOf(card);
  assert.equal(tests?.question, "Add tests");
  assert.isFalse(tests?.allowCustomAnswer);
  assert.deepEqual(
    tests?.options.map((option) => [option.label, option.description]),
    [
      ["Yes", "Recommended"],
      ["No", "No"],
    ],
  );
  assert.isFalse(region?.allowCustomAnswer);
  assert.deepEqual(
    region?.options.map((option) => [option.value, option.description]),
    [
      ["us", "us"],
      ["eu", "Recommended"],
    ],
  );
  assert.isFalse(notes?.required);
  assert.deepEqual(
    ompFormSubmission(
      card,
      card.entries,
      { tests: tests?.options[1]?.value, region: "us", notes: "" },
      new Map(),
    ),
    { data: { version: "2", region: "us", notes: "" } },
  );
  assert.deepEqual(
    ompFormSubmission(card, card.entries, { tests: "yes", region: "eu", notes: "x" }, new Map()),
    { data: { version: "2", tests: "yes", region: "eu", notes: "x" } },
  );
});

it("dismisses forms the card cannot ask", () => {
  for (const html of [
    "<form><p>Nothing to answer</p><input type=hidden name=a value=1></form>",
    '<form><input type="radio" name="x" value="a"><input type="text" name="x"></form>',
    '<form><label><input type="radio" name="x" value="a" disabled required> A</label></form>',
  ]) {
    assert.isTrue("unsupported" in ompFormCard(html), html);
  }
});
