import { expect, it } from "@effect/vitest";
import {
  ompAskChoice,
  ompAskChoicePresses,
  ompAskChoiceQuestion,
  ompAskPressValue,
  ompAskQuestions,
  ompAskResponse,
} from "./questions.ts";
it("preserves native ask order, multi selection, custom input and cancellation", () => {
  const questions = ompAskQuestions({
    questions: [
      {
        id: "scope",
        question: "Which scopes?",
        multi: true,
        options: [{ label: "Web" }, { label: "Mobile" }],
      },
      { id: "name", question: "Name?", options: [] },
    ],
  });
  expect(questions[0]?.multiSelect).toBe(true);
  expect(ompAskResponse(questions, { name: "Demo", scope: ["Web", "Mobile"] })).toEqual({
    answers: [
      { id: "scope", selectedOptions: ["Web", "Mobile"] },
      { id: "name", selectedOptions: [], customInput: "Demo" },
    ],
  });
  expect(ompAskResponse(questions, undefined)).toEqual({ cancelled: true });
});

const checkboxSelect = (checkedIndices: ReadonlyArray<number>, done = true) => ({
  method: "select",
  title: "Pick fruits",
  options: [
    "Apple",
    "Banana",
    "Cherry",
    "Other (type your own)",
    ...(done ? ["✓ Done selecting"] : []),
  ],
  selectionMarker: "checkbox",
  markableCount: 4,
  checkedIndices,
});

it("answers an ask checkbox list from one multi-select card", () => {
  const choice = ompAskChoice(checkboxSelect([1], true))!;
  const question = ompAskChoiceQuestion(
    { id: "q", header: "Question", question: "Pick fruits", options: [] },
    choice,
  );
  expect(question.multiSelect).toBe(true);
  expect(question.allowCustomAnswer).toBe(true);
  expect(question.options.map((option) => option.label)).toEqual(["Apple", "Banana", "Cherry"]);
  // Banana is already checked: toggle Apple on, Banana off, type Other, then finish.
  const presses = ompAskChoicePresses(choice, ["Apple", "Cherry", "Kiwi"]);
  expect(presses).toEqual([
    { select: "Apple" },
    { select: "Banana" },
    { select: "Cherry" },
    { select: "Other (type your own)" },
    { input: "Kiwi" },
    { done: true },
  ]);
  expect(choice.doneLabel).toBe("✓ Done selecting");
  // Later dialogs are answered without a card; Done is the row after the markable ones.
  expect(ompAskPressValue({ done: true }, "select", checkboxSelect([0, 2, 3]))).toBe(
    "✓ Done selecting",
  );
  expect(ompAskPressValue({ input: "Kiwi" }, "input", { method: "input" })).toBe("Kiwi");
  expect(ompAskPressValue({ select: "Fig" }, "select", checkboxSelect([]))).toBeUndefined();
  expect(ompAskChoicePresses(choice, undefined)).toBeUndefined();
});

it("answers an ask radio with a label or typed text through Other", () => {
  const choice = ompAskChoice({
    options: ["Red", "Green", "Other (type your own)"],
    selectionMarker: "radio",
  })!;
  expect(choice.multi).toBe(false);
  expect(ompAskChoicePresses(choice, "Green")).toEqual([{ select: "Green" }]);
  expect(ompAskChoicePresses(choice, "Teal")).toEqual([
    { select: "Other (type your own)" },
    { input: "Teal" },
  ]);
  expect(ompAskChoice({ options: ["Approve", "Deny"] })).toBeUndefined();
});
