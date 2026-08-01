/**
 * Product-level presentation signals. They intentionally contain no plan
 * titles, calendar content, credentials, activity rows, or other user data.
 */
export type PetPresentationEvent =
	| { kind: "plan-generation-started" }
	| { kind: "plan-generation-succeeded" }
	| { kind: "plan-generation-failed" }
	| { kind: "milestone-completed" }
	| { kind: "focus-started" }
	| { kind: "user-inactive" }
	| { kind: "reflection-encourage" }
	| { kind: "reflection-refocus" }
	| { kind: "reflection-clarify-goal" }
	| { kind: "reflection-take-break" };
