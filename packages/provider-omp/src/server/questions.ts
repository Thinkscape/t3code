import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import {
  ompRecordField as field,
  ompRecordNumber as number,
  ompRecordString as string,
} from "./rpc.ts";

export function ompAskQuestions(event: unknown): ReadonlyArray<OrchestrationV2UserInputQuestion> {
  const questions = field(event, "questions");
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    const id = string(question, "id");
    const text = string(question, "question");
    if (!id || !text) return [];
    const options = field(question, "options");
    return [
      {
        id,
        header: string(question, "header") ?? "Question",
        question: text,
        multiSelect: field(question, "multi") === true,
        allowCustomAnswer: true,
        options: Array.isArray(options)
          ? options.flatMap((option) => {
              const label = string(option, "label");
              return label
                ? [{ label, value: label, description: string(option, "description") ?? label }]
                : [];
            })
          : [],
      },
    ];
  });
}

export function ompAskResponse(
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>,
  answers: Record<string, unknown> | undefined,
) {
  if (answers === undefined) return { cancelled: true };
  return {
    answers: questions.map((question) => {
      const answer = answers[question.id];
      const values = Array.isArray(answer)
        ? answer.filter((value): value is string => typeof value === "string")
        : typeof answer === "string"
          ? [answer]
          : [];
      const labels = new Set(question.options.map((option) => option.label));
      const selectedOptions = values.filter((value) => labels.has(value));
      const customInput = values.filter((value) => !labels.has(value)).join("\n");
      return { id: question.id, selectedOptions, ...(customInput ? { customInput } : {}) };
    }),
  };
}

/**
 * A choice field of omp's `ask` tool. Over RPC it walks its form one `select` per pick: radios
 * once, checkboxes re-sent after every toggle until the action row after the markable options
 * ("Done selecting"); the "Other" row then asks for the text with an `input`.
 */
export interface OmpAskChoice {
  readonly multi: boolean;
  /** Pickable labels, without the Other row. */
  readonly labels: ReadonlyArray<string>;
  readonly otherLabel: string | undefined;
  /** Checked labels and whether Other holds text, from the select's `checkedIndices`. */
  readonly checked: ReadonlyArray<string>;
  readonly otherChecked: boolean;
  /** The checkbox list's finishing row, when the list may finish now. */
  readonly doneLabel: string | undefined;
}

/** One answer to an `ask` dialog: pick a label, type the Other text, or finish a checkbox list. */
export type OmpAskPress =
  | { readonly select: string }
  | { readonly input: string }
  | { readonly done: true };

const OMP_ASK_OTHER_ROW = "Other (type your own)";

function selectOptions(event: unknown): ReadonlyArray<string> {
  const options = field(event, "options");
  return Array.isArray(options)
    ? options.filter((option): option is string => typeof option === "string")
    : [];
}

export function ompAskChoice(event: unknown): OmpAskChoice | undefined {
  const marker = string(event, "selectionMarker");
  if (marker !== "radio" && marker !== "checkbox") return undefined;
  const options = selectOptions(event);
  const multi = marker === "checkbox";
  const rows = multi ? options.slice(0, number(event, "markableCount") ?? options.length) : options;
  const otherIndex = rows.findLastIndex((label) => label.startsWith(OMP_ASK_OTHER_ROW));
  const checkedIndices = field(event, "checkedIndices");
  const checked = new Set(
    multi && Array.isArray(checkedIndices)
      ? checkedIndices.filter((index): index is number => typeof index === "number")
      : [],
  );
  return {
    multi,
    labels: rows.filter((_, index) => index !== otherIndex),
    otherLabel: rows[otherIndex],
    checked: rows.filter((_, index) => index !== otherIndex && checked.has(index)),
    otherChecked: checked.has(otherIndex),
    doneLabel: multi ? options[rows.length] : undefined,
  };
}

/** T3's card for the choice: one multi-select question for a checkbox list, Other as free text. */
export function ompAskChoiceQuestion(
  question: OrchestrationV2UserInputQuestion,
  choice: OmpAskChoice,
): OrchestrationV2UserInputQuestion {
  return {
    ...question,
    ...(choice.multi ? { multiSelect: true } : {}),
    ...(choice.otherLabel === undefined ? {} : { allowCustomAnswer: true }),
    options: choice.labels.map((label) => ({ label, value: label, description: label })),
  };
}

/**
 * The dialog answers that turn T3's answer into omp's: toggles from the current checks to the
 * picked set, then Done; typed text goes through the Other row. Undefined cancels.
 */
export function ompAskChoicePresses(
  choice: OmpAskChoice,
  answer: unknown,
): ReadonlyArray<OmpAskPress> | undefined {
  const values = Array.isArray(answer)
    ? answer.filter((value): value is string => typeof value === "string")
    : typeof answer === "string"
      ? [answer]
      : undefined;
  if (values === undefined) return undefined;
  const picked = values.filter((value) => choice.labels.includes(value));
  const typed = values
    .filter((value) => !choice.labels.includes(value) && value.trim().length > 0)
    .join("\n");
  const other = choice.otherLabel;
  const typeOther: ReadonlyArray<OmpAskPress> =
    other === undefined || typed.length === 0 ? [] : [{ select: other }, { input: typed }];
  if (!choice.multi) {
    const first = picked[0];
    return first !== undefined ? [{ select: first }] : typeOther.length > 0 ? typeOther : undefined;
  }
  return [
    ...choice.labels
      .filter((label) => picked.includes(label) !== choice.checked.includes(label))
      .map((label) => ({ select: label })),
    // Pressing a checked Other row clears it; typing again checks it with the new text.
    ...(other !== undefined && choice.otherChecked ? [{ select: other }] : []),
    ...typeOther,
    { done: true as const },
  ];
}

/** The value answering `event` with `press`, or undefined when the dialog is not that step. */
export function ompAskPressValue(
  press: OmpAskPress,
  method: string,
  event: unknown,
): string | undefined {
  if ("input" in press) return method === "input" ? press.input : undefined;
  if (method !== "select") return undefined;
  const options = selectOptions(event);
  if ("select" in press) return options.includes(press.select) ? press.select : undefined;
  const markable = number(event, "markableCount");
  return string(event, "selectionMarker") === "checkbox" && markable !== undefined
    ? options[markable]
    : undefined;
}
