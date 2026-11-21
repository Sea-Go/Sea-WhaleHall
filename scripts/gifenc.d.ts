declare module "gifenc" {
	export function GIFEncoder(): {
		writeFrame(
			index: Uint8Array,
			width: number,
			height: number,
			options?: {
				palette?: number[][];
				delay?: number;
				transparent?: boolean;
				repeat?: number;
				first?: boolean;
			},
		): void;
		finish(): void;
		bytes(): Uint8Array;
		reset(): void;
	};
	export function quantize(
		rgba: Uint8Array | Uint8ClampedArray,
		maxColors: number,
		options?: {
			format?: string;
			oneBitAlpha?: boolean;
			clearAlpha?: boolean;
		},
	): number[][];
	export function applyPalette(
		rgba: Uint8Array | Uint8ClampedArray,
		palette: number[][],
		format?: string,
	): Uint8Array;
}
