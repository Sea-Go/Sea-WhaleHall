import { randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createScryptPasswordHash } from "../services/model-relay/password";
import type { RelayUser } from "../services/model-relay/types";
import {
	WHALEHALL_RELAY_BASE_URL,
	WHALEHALL_RELAY_MODEL,
	writeProvisionedClientConfiguration,
} from "../src/bun/client-config";

type Arguments = {
	configPath: string;
	usersPath: string;
	replace: boolean;
};

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	const email = normalizeEmail(await prompt("账号邮箱: "));
	const displayName = requireText(await prompt("显示名称: "), "显示名称", 96);
	const initials = requireText(await prompt("姓名缩写: "), "姓名缩写", 12);
	const password = await prompt("登录密码: ", true);
	const passwordConfirmation = await prompt("再次输入登录密码: ", true);
	if (password !== passwordConfirmation)
		throw new Error("两次输入的登录密码不一致。");
	const personalRelayKey = `whk_${randomBytes(32).toString("base64url")}`;
	const reflectionKeyId = `whref_${randomUUID().replaceAll("-", "")}`;
	const reflectionRelayKey = `${reflectionKeyId}.${randomBytes(32).toString("base64url")}`;
	const [passwordHash, agentKeyHash, reflectionKeyHash] = await Promise.all([
		createScryptPasswordHash(password),
		createScryptPasswordHash(personalRelayKey),
		createScryptPasswordHash(reflectionRelayKey),
	]);
	const user: RelayUser = {
		id: `user-${randomUUID()}`,
		email,
		displayName,
		initials,
		passwordHash,
		agentKeyHash,
		reflectionKeyId,
		reflectionKeyHash,
	};

	writeRelayUsersFile(args.usersPath, user, args.replace);
	writeProvisionedClientConfiguration({
		path: args.configPath,
		configuration: {
			reflection: {
				name: WHALEHALL_RELAY_MODEL,
				baseurl: WHALEHALL_RELAY_BASE_URL,
				apikey: reflectionRelayKey,
			},
			agent: {
				name: WHALEHALL_RELAY_MODEL,
				baseurl: WHALEHALL_RELAY_BASE_URL,
				apikey: personalRelayKey,
			},
		},
	});

	process.stdout.write(
		`${[
			"已写入 owner-only 本机 config.yaml 与仅含哈希的 relay 用户文件。",
			`本机配置：${args.configPath}`,
			`待部署用户文件：${args.usersPath}`,
			"反思 relay key 与个人 relay key 仅保存在本机 config.yaml，未打印、未写入用户文件。",
		].join("\n")}\n`,
	);
}

function parseArguments(values: readonly string[]): Arguments {
	let configPath: string | null = null;
	let usersPath: string | null = null;
	let replace = false;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (value === "--config") {
			configPath = values[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (value === "--users") {
			usersPath = values[index + 1] ?? null;
			index += 1;
			continue;
		}
		if (value === "--replace") {
			replace = true;
			continue;
		}
		throw new Error(`未知参数：${value}`);
	}
	if (!configPath || !usersPath) {
		throw new Error(
			"用法：bun run provision:relay-owner -- --config /绝对路径/config.yaml --users /绝对路径/relay-users.json [--replace]",
		);
	}
	if (!configPath.startsWith("/") || !usersPath.startsWith("/")) {
		throw new Error("--config 和 --users 必须是绝对路径。");
	}
	return {
		configPath: resolve(configPath),
		usersPath: resolve(usersPath),
		replace,
	};
}

function writeRelayUsersFile(
	path: string,
	user: RelayUser,
	replace: boolean,
): void {
	const directory = dirname(path);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	if (existsSync(path)) {
		const stat = lstatSync(path);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error("relay 用户文件目标必须是普通文件。");
		}
		if (!replace) {
			throw new Error(
				"relay 用户文件已经存在；确认替换后请显式添加 --replace。",
			);
		}
	}
	const temporary = `${path}.tmp-${randomUUID()}`;
	try {
		writeFileSync(
			temporary,
			`${JSON.stringify({ users: [user] }, null, 2)}\n`,
			{
				encoding: "utf8",
				mode: 0o600,
				flag: "wx",
			},
		);
		chmodSync(temporary, 0o600);
		renameSync(temporary, path);
		chmodSync(path, 0o600);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

async function prompt(label: string, hidden = false): Promise<string> {
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
		throw new Error("owner provisioning 必须在交互式终端中运行。");
	}
	process.stderr.write(label);
	process.stdin.setEncoding("utf8");
	process.stdin.setRawMode(true);
	process.stdin.resume();
	return new Promise<string>((resolvePrompt, rejectPrompt) => {
		let value = "";
		const finish = (error?: Error) => {
			process.stdin.off("data", onData);
			process.stdin.setRawMode(false);
			process.stderr.write("\n");
			if (error) rejectPrompt(error);
			else resolvePrompt(value);
		};
		const onData = (chunk: string) => {
			for (const character of chunk) {
				if (character === "\u0003") {
					finish(new Error("owner provisioning 已取消。"));
					return;
				}
				if (character === "\r" || character === "\n") {
					finish();
					return;
				}
				if (character === "\u007f" || character === "\b") {
					if (!value) continue;
					value = value.slice(0, -1);
					if (!hidden) process.stderr.write("\b \b");
					continue;
				}
				if (character >= " ") {
					value += character;
					if (!hidden) process.stderr.write(character);
				}
			}
		};
		process.stdin.on("data", onData);
	});
}

function normalizeEmail(value: string): string {
	const email = value.trim().toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320) {
		throw new Error("账号邮箱无效。");
	}
	return email;
}

function requireText(value: string, name: string, maximum: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maximum) {
		throw new Error(`${name}必须包含 1 到 ${maximum} 个字符。`);
	}
	return normalized;
}

void main().catch((error: unknown) => {
	const message =
		error instanceof Error ? error.message : "owner provisioning 失败。";
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
