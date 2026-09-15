import { expect, test } from "bun:test";
import { parseRTWHistoryJSON } from "../src/bun/clients/product/rtw-history-json";

test("JSON重复字段按解码后的键比较，不能用Unicode转义绕过", () => {
	expect(() =>
		parseRTWHistoryJSON('{"subject_id":"42","subject\\u005fid":"43"}'),
	).toThrow();
	expect(() =>
		parseRTWHistoryJSON(
			'{"items":[{"subject":{"issuer":"rtw.identity","issuer":"other"}}]}',
		),
	).toThrow();
	expect(
		parseRTWHistoryJSON('{"items":[{"subject_id":"42"},{"subject_id":"43"}]}'),
	).toEqual({ items: [{ subject_id: "42" }, { subject_id: "43" }] });
});

test("JSON词法扫描保留字符串转义与数字语法，不吞掉尾部", () => {
	expect(parseRTWHistoryJSON('{"quote":"海\\n湾","count":42}')).toEqual({
		quote: "海\n湾",
		count: 42,
	});
	expect(() => parseRTWHistoryJSON('{"count":01}')).toThrow();
	expect(() => parseRTWHistoryJSON('{"count":1} trailing')).toThrow();
});
