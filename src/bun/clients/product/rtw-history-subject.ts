import { z } from "zod";

const MAX_UID = 9223372036854775807n;
const CANONICAL_UID = /^[1-9][0-9]{0,18}$/u;
const uid = z
	.string()
	.refine((value) => CANONICAL_UID.test(value) && BigInt(value) <= MAX_UID);

export const rtwSubjectV1 = z
	.object({
		authority_id: z.literal("rtw.identity"),
		tenant_id: z.literal("platform"),
		subject_id: uid,
	})
	.strict();

export const rtwSubjectV2 = z
	.object({
		issuer: z.literal("rtw.identity"),
		subject_id: uid,
	})
	.strict();

export const rtwHistorySubject = z.union([rtwSubjectV1, rtwSubjectV2]);

export type RTWHistorySubject = z.infer<typeof rtwHistorySubject>;

export function rtwSubjectVersion(subject: RTWHistorySubject): 1 | 2 {
	return "authority_id" in subject ? 1 : 2;
}

/** One canonical RTW user. The v1 platform slot is never a product tenant. */
export function canonicalRTWSubject(subject: RTWHistorySubject): {
	issuer: "rtw.identity";
	subjectId: string;
} {
	return {
		issuer: "rtw.identity",
		subjectId: subject.subject_id,
	};
}
