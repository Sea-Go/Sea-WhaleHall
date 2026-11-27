import type { PetFrame, PetModelTheme } from "../src/views/pet/core/types";
import {
	applyPoseTransform,
	clamp01,
	paletteForTone,
	type LocalPoseTransform,
} from "../src/views/pet/models/shared";

/**
 * 矢量绘制源（仅供 render-pet-skins.ts 离线烘焙 GIF）。
 *
 * whale/cat 运行时已统一为 GIF 序列帧皮肤；本文件是它们的"绘制源素材"——
 * 想改矢量皮肤的形象/动作，改这里然后重跑 `bun run render:pet-skins`
 * 重新烘焙 GIF。不要在运行时 import 本文件。
 */

export type VectorSkinId = "whale" | "cat";

export const VECTOR_SKIN_BOUNDS: Record<
	VectorSkinId,
	{ x: number; y: number; width: number; height: number }
> = {
	whale: { x: -153, y: -68, width: 267, height: 139 },
	cat: { x: -113, y: -99, width: 202, height: 167 },
};

const WHALE_THEME: PetModelTheme = {
	colors: {
		outline: "#063347",
		accent: "#ff8fab",
		"neutral.primary": "#b3d8ec",
		"neutral.secondary": "#6a9bd1",
		"neutral.dark": "#3d6fa3",
		"neutral.light": "#edf7ff",
	},
};

function whalePose(frame: PetFrame): LocalPoseTransform {
	const lie = clamp01(frame.pose.lie);
	const sit = clamp01(frame.pose.sit);
	const crouch = clamp01(frame.pose.crouch);
	const squash = frame.pose.squash;
	return {
		x: 0,
		y: crouch * 10 + sit * 15 + lie * 23,
		rotation: lie * 0.22 + frame.pose.lean * 0.08,
		scaleX: 1 + frame.pose.stretch * 0.06 + squash * 0.08 + lie * 0.05,
		scaleY:
			1 + frame.pose.breath * 0.018 + frame.pose.stretch * 0.08 -
			squash * 0.1 - sit * 0.08 - lie * 0.17,
	};
}

function drawWhaleEye(
	context: CanvasRenderingContext2D,
	frame: PetFrame,
	outline: string,
): void {
	const eyeX = 58;
	const eyeY = -17;
	const eyes = frame.expression.eyes;
	const openAmount = clamp01(frame.expression.eyeOpen);
	context.lineCap = "round";

	if (eyes === "love") {
		context.fillStyle = "#ff6398";
		context.beginPath();
		context.moveTo(eyeX, eyeY + 6);
		context.bezierCurveTo(eyeX - 9, eyeY - 1, eyeX - 6, eyeY - 9, eyeX, eyeY - 4);
		context.bezierCurveTo(eyeX + 6, eyeY - 9, eyeX + 9, eyeY - 1, eyeX, eyeY + 6);
		context.fill();
		return;
	}

	if (eyes === "dizzy") {
		context.strokeStyle = outline;
		context.lineWidth = 2.2;
		context.beginPath();
		context.arc(eyeX, eyeY, 7, 0, Math.PI * 2);
		context.arc(eyeX, eyeY, 3.5, 0, Math.PI * 2);
		context.stroke();
		return;
	}

	if (
		openAmount < 0.12 ||
		eyes === "closed" ||
		eyes === "happy" ||
		eyes === "laugh" ||
		eyes === "shy" ||
		eyes === "proud" ||
		eyes === "wink" ||
		eyes === "angry" ||
		eyes === "sleepy"
	) {
		context.strokeStyle = outline;
		context.lineWidth = 3;
		context.beginPath();
		if (eyes === "angry") {
			context.moveTo(51, eyeY - 5);
			context.lineTo(66, eyeY + 2);
		} else if (eyes === "laugh") {
			context.moveTo(51, eyeY - 2);
			context.quadraticCurveTo(58, eyeY + 6, 66, eyeY - 1);
		} else if (eyes === "proud") {
			context.moveTo(51, eyeY + 1);
			context.quadraticCurveTo(58, eyeY - 5, 66, eyeY - 1);
		} else if (eyes === "happy") {
			context.arc(eyeX, eyeY + 3, 7, Math.PI * 1.12, Math.PI * 1.88);
		} else {
			context.moveTo(51, eyeY);
			context.quadraticCurveTo(58, eyeY + (1 - openAmount) * 5 + 2, 66, eyeY);
		}
		context.stroke();
		return;
	}

	const afraid = eyes === "afraid";
	const surprised = eyes === "surprised";
	const radiusX = surprised || afraid ? 9.5 : 8;
	const radiusY = (surprised || afraid ? 10.5 : 9) * Math.max(0.2, openAmount);
	context.fillStyle = "rgba(248, 255, 255, 0.97)";
	context.beginPath();
	context.ellipse(eyeX, eyeY, radiusX, radiusY, 0, 0, Math.PI * 2);
	context.fill();
	const pupilRadius = afraid ? 2.2 : 4.1;
	const pupilX = eyeX + Math.max(-1, Math.min(1, frame.expression.look.x)) * 3.4;
	const pupilY = eyeY + Math.max(-1, Math.min(1, frame.expression.look.y)) * 2.6;
	context.fillStyle = outline;
	context.beginPath();
	context.arc(pupilX, pupilY, pupilRadius, 0, Math.PI * 2);
	context.fill();
	context.fillStyle = "#fff";
	context.beginPath();
	context.arc(pupilX + 1.2, pupilY - 1.4, 1.25, 0, Math.PI * 2);
	context.fill();
	if (eyes === "confused" || eyes === "wronged") {
		context.strokeStyle = outline;
		context.lineWidth = 2;
		context.beginPath();
		context.moveTo(50, eyeY - 11);
		context.quadraticCurveTo(58, eyeY - (eyes === "wronged" ? 8 : 13), 67, eyeY - 10);
		context.stroke();
	}
}

function drawWhaleMouth(
	context: CanvasRenderingContext2D,
	frame: PetFrame,
	outline: string,
): void {
	const mouth = frame.expression.mouth;
	context.strokeStyle = outline;
	context.fillStyle = outline;
	context.lineWidth = 2.3;
	context.lineCap = "round";
	context.beginPath();
	if (mouth === "open" || mouth === "o" || mouth === "yawn") {
		const radiusX = mouth === "yawn" ? 7 : 5;
		const radiusY = mouth === "yawn" ? 11 : mouth === "open" ? 8 : 5;
		context.ellipse(72, 3, radiusX, radiusY, 0, 0, Math.PI * 2);
		context.fill();
	} else if (mouth === "laugh" || mouth === "grin") {
		context.moveTo(62, -1);
		context.quadraticCurveTo(72, 15, 82, -1);
		context.quadraticCurveTo(72, 6, 62, -1);
		context.fill();
		context.fillStyle = "#ff8da9";
		context.beginPath();
		context.ellipse(72, 7, 5, 2.6, 0, 0, Math.PI * 2);
		context.fill();
	} else if (mouth === "frown" || mouth === "pout") {
		context.arc(72, 12, 13, Math.PI * 1.25, Math.PI * 1.75);
		context.stroke();
	} else if (mouth === "flat" || mouth === "small") {
		context.moveTo(mouth === "small" ? 68 : 65, 5);
		context.lineTo(mouth === "small" ? 76 : 79, 5);
		context.stroke();
	} else if (mouth === "wavy") {
		context.moveTo(64, 5);
		context.quadraticCurveTo(68, 0, 72, 5);
		context.quadraticCurveTo(76, 10, 80, 5);
		context.stroke();
	} else {
		context.arc(70, -3, 15, 0.35, 1.5);
		context.stroke();
	}
}

export function drawWhale(
	context: CanvasRenderingContext2D,
	frame: PetFrame,
): void {
	const palette = paletteForTone(WHALE_THEME, frame.tone);
	const pose = whalePose(frame);
	context.save();
	applyPoseTransform(context, pose);

	context.save();
	context.translate(-91, -1);
	context.rotate(frame.pose.tailSwing * 0.28);
	const tail = context.createLinearGradient(-62, -42, 3, 32);
	tail.addColorStop(0, palette.primary);
	tail.addColorStop(1, palette.dark);
	context.fillStyle = tail;
	context.beginPath();
	context.moveTo(0, 0);
	context.quadraticCurveTo(-43, -50, -59, -23);
	context.quadraticCurveTo(-49, 2, -7, 10);
	context.quadraticCurveTo(-51, 21, -58, 49);
	context.quadraticCurveTo(-22, 54, 0, 8);
	context.closePath();
	context.fill();
	context.restore();

	const body = context.createLinearGradient(-80, -56, 95, 54);
	body.addColorStop(0, palette.primary);
	body.addColorStop(0.56, palette.secondary);
	body.addColorStop(1, palette.dark);
	context.fillStyle = body;
	context.beginPath();
	context.moveTo(-97, 0);
	context.bezierCurveTo(-84, -56, 31, -68, 94, -23);
	context.bezierCurveTo(114, -7, 105, 31, 62, 49);
	context.bezierCurveTo(4, 71, -79, 45, -97, 0);
	context.closePath();
	context.fill();
	context.strokeStyle = "rgba(4, 53, 72, 0.25)";
	context.lineWidth = 1.5;
	context.stroke();

	context.fillStyle = palette.light;
	context.globalAlpha *= 0.76;
	context.beginPath();
	context.ellipse(18, 34, 58, 22, -0.08, 0, Math.PI * 2);
	context.fill();
	context.globalAlpha /= 0.76;

	context.save();
	context.translate(17, 38);
	context.rotate(0.48 + frame.pose.primaryLimb * 0.52);
	context.fillStyle = palette.dark;
	context.globalAlpha *= 0.68;
	context.beginPath();
	context.ellipse(16, 5, 35, 10, 0, 0, Math.PI * 2);
	context.fill();
	context.restore();

	context.strokeStyle = palette.outline;
	context.globalAlpha *= 0.6;
	context.lineWidth = 2;
	context.beginPath();
	context.moveTo(3, -51);
	context.quadraticCurveTo(8, -56 - frame.pose.breath, 14, -51);
	context.stroke();
	context.globalAlpha /= 0.6;

	drawWhaleEye(context, frame, palette.outline);
	if (frame.expression.blush > 0) {
		context.fillStyle = `rgba(255, 124, 157, ${0.16 + frame.expression.blush * 0.62})`;
		context.beginPath();
		context.ellipse(78, 3, 11, 5, -0.14, 0, Math.PI * 2);
		context.fill();
	}
	drawWhaleMouth(context, frame, palette.outline);
	context.restore();
}

const CAT_THEME: PetModelTheme = {
	colors: {
		outline: "#3b2c43",
		accent: "#ff8ba7",
		"neutral.primary": "#f5bf69",
		"neutral.secondary": "#d98448",
		"neutral.dark": "#92533f",
		"neutral.light": "#fff0cf",
	},
};

function catPose(frame: PetFrame): LocalPoseTransform {
	const lie = clamp01(frame.pose.lie);
	const sit = clamp01(frame.pose.sit);
	const crouch = clamp01(frame.pose.crouch);
	return {
		x: lie * 3,
		y: crouch * 11 + sit * 13 + lie * 25,
		rotation: frame.pose.lean * 0.06 - lie * 0.03,
		scaleX: 1 + frame.pose.stretch * 0.04 + lie * 0.14 + frame.pose.squash * 0.06,
		scaleY:
			1 + frame.pose.breath * 0.014 + frame.pose.stretch * 0.1 -
			sit * 0.1 - lie * 0.24 - frame.pose.squash * 0.09,
	};
}

function drawCatEye(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	frame: PetFrame,
	outline: string,
): void {
	const eyes = frame.expression.eyes;
	const openAmount = clamp01(frame.expression.eyeOpen);
	if (eyes === "love") {
		context.fillStyle = "#ff5f8f";
		context.beginPath();
		context.moveTo(x, y + 5);
		context.bezierCurveTo(x - 7, y, x - 5, y - 7, x, y - 3);
		context.bezierCurveTo(x + 5, y - 7, x + 7, y, x, y + 5);
		context.fill();
		return;
	}
	if (
		openAmount < 0.12 || eyes === "closed" || eyes === "happy" ||
		eyes === "laugh" || eyes === "shy" || eyes === "proud" ||
		eyes === "wink" || eyes === "angry" || eyes === "sleepy"
	) {
		context.strokeStyle = outline;
		context.lineWidth = 2.7;
		context.lineCap = "round";
		context.beginPath();
		if (eyes === "angry") {
			context.moveTo(x - 6, y - 4);
			context.lineTo(x + 6, y + 1);
		} else if (eyes === "happy" || eyes === "laugh") {
			context.arc(x, y + 3, 6, Math.PI * 1.12, Math.PI * 1.88);
		} else if (eyes === "proud") {
			context.moveTo(x - 6, y + 1);
			context.quadraticCurveTo(x, y - 4, x + 6, y);
		} else {
			context.moveTo(x - 6, y);
			context.quadraticCurveTo(x, y + 2 + (1 - openAmount) * 4, x + 6, y);
		}
		context.stroke();
		return;
	}
	if (eyes === "dizzy") {
		context.strokeStyle = outline;
		context.lineWidth = 2;
		context.beginPath();
		context.arc(x, y, 6, 0, Math.PI * 2);
		context.arc(x, y, 2.8, 0, Math.PI * 2);
		context.stroke();
		return;
	}
	const surprised = eyes === "surprised" || eyes === "afraid";
	context.fillStyle = "#fffdf7";
	context.beginPath();
	context.ellipse(x, y, surprised ? 7.5 : 6.5, surprised ? 9 : 7.5, 0, 0, Math.PI * 2);
	context.fill();
	const lookX = Math.max(-1, Math.min(1, frame.expression.look.x)) * 2.5;
	const lookY = Math.max(-1, Math.min(1, frame.expression.look.y)) * 2;
	context.fillStyle = outline;
	context.beginPath();
	context.ellipse(x + lookX, y + lookY, eyes === "afraid" ? 1.7 : 2.7, 4, 0, 0, Math.PI * 2);
	context.fill();
	context.fillStyle = "#fff";
	context.beginPath();
	context.arc(x + lookX + 0.8, y + lookY - 1.4, 0.9, 0, Math.PI * 2);
	context.fill();
}

function drawCatMouth(
	context: CanvasRenderingContext2D,
	frame: PetFrame,
	outline: string,
): void {
	const mouth = frame.expression.mouth;
	context.strokeStyle = outline;
	context.fillStyle = outline;
	context.lineWidth = 2;
	context.lineCap = "round";
	context.beginPath();
	if (mouth === "open" || mouth === "o" || mouth === "yawn") {
		context.ellipse(45, -27, mouth === "yawn" ? 6 : 4, mouth === "yawn" ? 9 : 5, 0, 0, Math.PI * 2);
		context.fill();
	} else if (mouth === "laugh" || mouth === "grin") {
		context.moveTo(36, -30);
		context.quadraticCurveTo(45, -17, 54, -30);
		context.closePath();
		context.fill();
		context.fillStyle = "#ff8fa3";
		context.beginPath();
		context.ellipse(45, -23, 4, 2, 0, 0, Math.PI * 2);
		context.fill();
	} else if (mouth === "frown" || mouth === "pout") {
		context.arc(45, -20, 9, Math.PI * 1.2, Math.PI * 1.8);
		context.stroke();
	} else if (mouth === "flat" || mouth === "small") {
		context.moveTo(mouth === "small" ? 42 : 38, -25);
		context.lineTo(mouth === "small" ? 48 : 52, -25);
		context.stroke();
	} else if (mouth === "wavy") {
		context.moveTo(37, -25);
		context.quadraticCurveTo(41, -29, 45, -25);
		context.quadraticCurveTo(49, -21, 53, -25);
		context.stroke();
	} else {
		context.moveTo(45, -28);
		context.quadraticCurveTo(41, -23, 36, -27);
		context.moveTo(45, -28);
		context.quadraticCurveTo(49, -23, 54, -27);
		context.stroke();
	}
}

export function drawCat(
	context: CanvasRenderingContext2D,
	frame: PetFrame,
): void {
	const palette = paletteForTone(CAT_THEME, frame.tone);
	const pose = catPose(frame);
	const gait = Math.sin(frame.pose.gaitPhase * Math.PI * 2) * frame.pose.gaitWeight;
	context.save();
	applyPoseTransform(context, pose);

	context.save();
	context.translate(-63, 3);
	context.rotate(-0.35 + frame.pose.tailSwing * 0.42);
	context.strokeStyle = palette.dark;
	context.lineWidth = 17;
	context.lineCap = "round";
	context.beginPath();
	context.moveTo(0, 0);
	context.bezierCurveTo(-27, -14, -43, -47, -19, -65);
	context.bezierCurveTo(-7, -74, 5, -66, 1, -57);
	context.stroke();
	context.strokeStyle = palette.primary;
	context.lineWidth = 11;
	context.stroke();
	context.restore();

	for (const [x, phase] of [[-42, gait], [-16, -gait]] as const) {
		context.save();
		context.translate(x, 31);
		context.rotate(phase * 0.2 + frame.pose.secondaryLimb * 0.18);
		context.fillStyle = palette.dark;
		context.beginPath();
		context.roundRect(-10, -5, 21, 37, 10);
		context.fill();
		context.fillStyle = palette.light;
		context.beginPath();
		context.ellipse(2, 28, 13, 7, 0, 0, Math.PI * 2);
		context.fill();
		context.restore();
	}

	const body = context.createLinearGradient(-65, -35, 63, 45);
	body.addColorStop(0, palette.primary);
	body.addColorStop(0.62, palette.secondary);
	body.addColorStop(1, palette.dark);
	context.fillStyle = body;
	context.beginPath();
	context.ellipse(-19, 3, 62, 45, 0.06, 0, Math.PI * 2);
	context.fill();
	context.strokeStyle = "rgba(61, 38, 42, 0.22)";
	context.lineWidth = 1.4;
	context.stroke();
	context.fillStyle = palette.light;
	context.globalAlpha *= 0.68;
	context.beginPath();
	context.ellipse(3, 17, 37, 23, -0.05, 0, Math.PI * 2);
	context.fill();
	context.globalAlpha /= 0.68;

	for (const [x, phase] of [[18, -gait], [39, gait]] as const) {
		context.save();
		context.translate(x, 24);
		context.rotate(phase * 0.24 + frame.pose.primaryLimb * 0.28);
		context.fillStyle = palette.secondary;
		context.beginPath();
		context.roundRect(-9, -7, 19, 42, 9);
		context.fill();
		context.fillStyle = palette.light;
		context.beginPath();
		context.ellipse(1, 32, 12, 7, 0, 0, Math.PI * 2);
		context.fill();
		context.restore();
	}

	context.save();
	context.translate(0, frame.pose.headTilt * 2);
	context.rotate(frame.pose.headTilt * 0.1);
	context.fillStyle = palette.dark;
	context.beginPath();
	context.moveTo(12, -65);
	context.lineTo(15, -96);
	context.lineTo(36, -70);
	context.moveTo(54, -71);
	context.lineTo(75, -96);
	context.lineTo(77, -61);
	context.fill();
	context.fillStyle = "#f3a2a7";
	context.beginPath();
	context.moveTo(18, -68);
	context.lineTo(19, -87);
	context.lineTo(31, -70);
	context.moveTo(59, -72);
	context.lineTo(71, -87);
	context.lineTo(72, -65);
	context.fill();

	const head = context.createLinearGradient(12, -78, 78, -21);
	head.addColorStop(0, palette.primary);
	head.addColorStop(1, palette.secondary);
	context.fillStyle = head;
	context.beginPath();
	context.ellipse(45, -50, 41, 35, -0.02, 0, Math.PI * 2);
	context.fill();
	context.strokeStyle = "rgba(61, 38, 42, 0.22)";
	context.stroke();

	context.strokeStyle = palette.dark;
	context.globalAlpha *= 0.54;
	context.lineWidth = 3;
	context.lineCap = "round";
	for (const [x, tilt] of [[34, -0.14], [45, 0], [56, 0.14]] as const) {
		context.beginPath();
		context.moveTo(x, -78);
		context.lineTo(x + tilt * 20, -69);
		context.stroke();
	}
	context.globalAlpha /= 0.54;

	drawCatEye(context, 29, -52, frame, palette.outline);
	drawCatEye(context, 58, -52, frame, palette.outline);
	context.fillStyle = "#a95568";
	context.beginPath();
	context.moveTo(41, -37);
	context.quadraticCurveTo(45, -34, 49, -37);
	context.quadraticCurveTo(45, -31, 41, -37);
	context.fill();
	if (frame.expression.blush > 0) {
		context.fillStyle = `rgba(255, 113, 143, ${0.12 + frame.expression.blush * 0.56})`;
		context.beginPath();
		context.ellipse(18, -34, 9, 4, 0.08, 0, Math.PI * 2);
		context.ellipse(70, -34, 9, 4, -0.08, 0, Math.PI * 2);
		context.fill();
	}
	drawCatMouth(context, frame, palette.outline);
	context.restore();
	context.restore();
}
