import type { OrchestratorFixtureInput } from "../../shared.ts";

const OMP_ASK_FORM_HTML = [
  "<form>",
  '<fieldset><legend>Session store</legend><label><input type="radio" name="store" value="sqlite" checked> SQLite</label><label><input type="radio" name="store" value="redis"> Redis</label></fieldset>',
  '<p>Which platforms?</p><label><input type="checkbox" name="platforms" value="web"> Web</label><label><input type="checkbox" name="platforms" value="ios"> iOS</label>',
  '<label>Project name <input type="text" name="project" required></label>',
  "</form>",
].join("");

export const OMP_ASK_FORM_PROMPT = `Call the ask tool exactly once with this html, verbatim: ${OMP_ASK_FORM_HTML} After I answer, reply with exactly the JSON form data you received and nothing else.`;

/**
 * omp 19 sends the ask tool's form as one `form` dialog; the card asks one question per named
 * control, keyed by its name. `Android` is the checkbox group's "Other" answer.
 */
const OMP_ASK_FORM_ANSWERS = {
  store: "redis",
  platforms: ["web", "Android"],
  project: "demo",
};

export function ompAskFormInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OMP_ASK_FORM_PROMPT },
      { type: "answer_next_user_input_request", answers: OMP_ASK_FORM_ANSWERS },
    ],
  };
}
