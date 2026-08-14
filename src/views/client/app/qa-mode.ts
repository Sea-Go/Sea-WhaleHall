export interface QaLocation {
	search: string;
	hash: string;
}

/** Renderer-only fixture controls. Authentication remains Bun-gated. */
export function qaControlsEnabled(location: QaLocation): boolean {
	const search = location.search.startsWith("?") ? location.search.slice(1) : "";
	const hashSearch = location.hash.startsWith("#?")
		? location.hash.slice(2)
		: "";
	return [search, hashSearch].some(
		(value) => value !== "" && new URLSearchParams(value).get("qa") === "1",
	);
}
