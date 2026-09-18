import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cStringLiteral,
	parseCodeDirectoryHash,
	parseMachOUuid,
	validateVaultBrokerReproducibility,
	vaultBrokerCodesignCommand,
	vaultBrokerCompileCommand,
	vaultBrokerExecutableName,
	vaultBrokerIdentifier,
	vaultBrokerPeerRequirements,
} from "../scripts/build-native";
import {
	MACOS_VAULT_BROKER_IDENTIFIER,
	validateVaultBrokerContinuity,
} from "../scripts/macos-build-security";

const fingerprint = "A".repeat(40);
const cdHash = "B".repeat(40);
const unsignedHash = "c".repeat(64);
const machOUuid = "12345678-1234-5678-9ABC-123456789ABC";
const machODetails = `Load command 8\n      cmd LC_UUID\n  cmdsize 24\n     uuid ${machOUuid}\n`;
const designatedRequirement =
	`designated => identifier "com.seago.whalehall.vault-broker.v2" ` +
	`and certificate leaf = H"${fingerprint}"`;

describe("Vault Broker build contract", () => {
	test("hard-bumps every immutable identity and wire namespace to v2", () => {
		expect(vaultBrokerExecutableName).toBe("whalehall-vault-broker-v2");
		expect(vaultBrokerIdentifier).toBe("com.seago.whalehall.vault-broker.v2");
		const frame = readFileSync(
			resolve(import.meta.dir, "../native/vault-broker/frame.c"),
			"utf8",
		);
		const keychain = readFileSync(
			resolve(import.meta.dir, "../native/vault-broker/keychain_store.c"),
			"utf8",
		);
		const guard = readFileSync(
			resolve(import.meta.dir, "../native/vault-broker/process_guard.c"),
			"utf8",
		);
		expect(frame).toContain("'W', 'H', 'V', 'B', 'R', 'E', 'Q', '2'");
		expect(frame).toContain("'W', 'H', 'V', 'B', 'R', 'S', 'P', '2'");
		expect(frame).toContain("frame[8] != 2U");
		expect(keychain).toContain(
			'"com.seago.whalehall.observation-v2.local-broker-v2"',
		);
		expect(guard).toContain('"whalehall-vault-broker-v2"');
	});

	test("uses static local-certificate validation instead of unsupported dynamic guests", () => {
		const guard = readFileSync(
			resolve(import.meta.dir, "../native/vault-broker/process_guard.c"),
			"utf8",
		);
		expect(guard).toContain("LOCAL_PEERTOKEN");
		expect(guard).toContain("SecStaticCodeCreateWithPath");
		expect(guard).toContain("SecStaticCodeCheckValidity");
		expect(guard).toContain("kSecCSCheckNestedCode");
		expect(guard).not.toContain("SecCodeCopyGuestWithAttributes");
		expect(guard).not.toContain("kSecGuestAttributePid");
	});

	test("uses unambiguous codesign display arguments in the macOS runtime", () => {
		const broker = readFileSync(
			resolve(
				import.meta.dir,
				"../native/local-host/core/src/vault_broker.rs",
			),
			"utf8",
		);
		const observations = readFileSync(
			resolve(
				import.meta.dir,
				"../native/local-host/core/src/observations.rs",
			),
			"utf8",
		);
		expect(broker).toContain('.arg("--display")');
		expect(broker).toContain('.arg("--requirements")');
		expect(broker).not.toContain('.arg("-dr")');
		expect(observations).toContain('.arg("--display")');
		expect(observations).not.toContain('.arg("-dv")');
	});

	test("passes escaped requirements to clang as single argv elements", () => {
		const command = vaultBrokerCompileCommand({
			arch: "arm64",
			source: "/source path/main.c",
			additionalSources: [
				"/source path/frame.c",
				"/source path/keychain_store.c",
				"/source path/process_guard.c",
			],
			output: "/output path/broker",
			signing: {
				kind: "local",
				identity: fingerprint,
				releaseRequired: false,
			},
		});
		const coreDefinition = command.find((argument) =>
			argument.startsWith("-DWHALEHALL_CORE_REQUIREMENT="),
		);
		const outerDefinition = command.find((argument) =>
			argument.startsWith("-DWHALEHALL_OUTER_REQUIREMENT="),
		);
		expect(coreDefinition).toBe(
			`-DWHALEHALL_CORE_REQUIREMENT="identifier \\"com.seago.whalehall.local\\" ` +
				`and certificate leaf = H\\"${fingerprint}\\""`,
		);
		expect(outerDefinition).toBe(
			`-DWHALEHALL_OUTER_REQUIREMENT="identifier \\"com.seago.whalehall\\" ` +
				`and certificate leaf = H\\"${fingerprint}\\""`,
		);
		expect(command).toContain("-mmacosx-version-min=14.0");
		expect(command).not.toContain("-Wl,-no_uuid");
		expect(command).toContain("-lbsm");
		expect(command).toContain("/source path/main.c");
		expect(command).toContain("/source path/frame.c");
		expect(command).toContain("/source path/keychain_store.c");
		expect(command).toContain("/source path/process_guard.c");
		expect(command.at(-1)).toBe("/output path/broker");
	});

	test("escapes C quotes and backslashes without accepting control text", () => {
		expect(cStringLiteral('identifier "a\\b"')).toBe(
			'"identifier \\"a\\\\b\\""',
		);
		expect(() => cStringLiteral("line one\nline two")).toThrow(
			"printable ASCII",
		);
	});

	test("fails closed when a signing plan lacks its required identity", () => {
		expect(() =>
			vaultBrokerPeerRequirements({
				kind: "local",
				releaseRequired: false,
			}),
		).toThrow("identity is unavailable");
		expect(() =>
			vaultBrokerCodesignCommand({
				executable: "/tmp/broker",
				signing: {
					kind: "developer-id",
					teamIdentifier: "ABCDE12345",
					releaseRequired: true,
				},
			}),
		).toThrow("signing is incomplete");
	});

	test("uses explicit hardened designated requirements for local and Developer ID builds", () => {
		const local = vaultBrokerCodesignCommand({
			executable: "/tmp/local-broker",
			signing: {
				kind: "local",
				identity: fingerprint,
				releaseRequired: false,
			},
		});
		expect(local).toContain("--options");
		expect(local).toContain("runtime");
		expect(local).toContain("--timestamp=none");
		expect(local).toContain(
			`=designated => identifier "${vaultBrokerIdentifier}" ` +
				`and certificate leaf = H"${fingerprint}"`,
		);

		const developer = vaultBrokerCodesignCommand({
			executable: "/tmp/release-broker",
			signing: {
				kind: "developer-id",
				identity: "D".repeat(40),
				teamIdentifier: "ABCDE12345",
				releaseRequired: true,
			},
		});
		expect(developer).toContain("--timestamp");
		expect(developer.join(" ")).toContain(
			'anchor apple generic and certificate leaf[subject.OU] = "ABCDE12345"',
		);
	});

	test("compiles an ad-hoc broker with unsatisfiable caller requirements", () => {
		const requirements = vaultBrokerPeerRequirements({
			kind: "ad-hoc",
			releaseRequired: false,
		});
		expect(requirements).toEqual({
			core: "false",
			outer: "false",
			enabled: false,
		});
		const command = vaultBrokerCompileCommand({
			arch: "x64",
			source: "/tmp/main.c",
			output: "/tmp/broker",
			signing: { kind: "ad-hoc", releaseRequired: false },
		});
		expect(command).toContain('-DWHALEHALL_CORE_REQUIREMENT="false"');
		expect(command).toContain('-DWHALEHALL_OUTER_REQUIREMENT="false"');
		expect(command).toContain("-DWHALEHALL_VAULT_ENABLED=0");
		const signingCommand = vaultBrokerCodesignCommand({
			executable: "/tmp/broker",
			signing: { kind: "ad-hoc", releaseRequired: false },
		});
		expect(signingCommand).toContain("--requirements");
		expect(signingCommand).toContain(
			`=designated => identifier "${vaultBrokerIdentifier}"`,
		);
		expect(signingCommand).toContain("--timestamp=none");
	});

	test("keeps the ad-hoc broker requirement deterministic and identifier-bound", () => {
		const command = vaultBrokerCodesignCommand({
			executable: "/tmp/ad-hoc-broker",
			signing: { kind: "ad-hoc", releaseRequired: false },
		});
		expect(command).toContain("--requirements");
		expect(command).toContain(
			`=designated => identifier "${vaultBrokerIdentifier}"`,
		);
		expect(command).toContain("--timestamp=none");
	});

	test("rejects nondeterministic compilation and changed signed CDHashes", () => {
		expect(() =>
			validateVaultBrokerReproducibility({
				firstUnsignedHash: unsignedHash,
				secondUnsignedHash: "d".repeat(64),
				firstMachODetails: machODetails,
				secondMachODetails: machODetails,
				firstSignedDetails: `CDHash=${cdHash}`,
				secondSignedDetails: `CDHash=${cdHash}`,
				firstSignedRequirement: designatedRequirement,
				secondSignedRequirement: designatedRequirement,
			}),
		).toThrow("not byte-for-byte reproducible");
		expect(() =>
			validateVaultBrokerReproducibility({
				firstUnsignedHash: unsignedHash,
				secondUnsignedHash: unsignedHash,
				firstMachODetails: machODetails,
				secondMachODetails: machODetails,
				firstSignedDetails: `CDHash=${cdHash}`,
				secondSignedDetails: `CDHash=${"E".repeat(40)}`,
				firstSignedRequirement: designatedRequirement,
				secondSignedRequirement: designatedRequirement,
			}),
		).toThrow("same CDHash");
		expect(parseCodeDirectoryHash(`Executable=x\nCDHash=${cdHash}\n`)).toBe(
			cdHash,
		);
	});

	test("requires one deterministic non-zero LC_UUID", () => {
		expect(parseMachOUuid(machODetails)).toBe(machOUuid);
		expect(() => parseMachOUuid("Load command 8\ncmd LC_UUID\n")).toThrow(
			"non-zero LC_UUID",
		);
		expect(() =>
			validateVaultBrokerReproducibility({
				firstUnsignedHash: unsignedHash,
				secondUnsignedHash: unsignedHash,
				firstMachODetails: machODetails,
				secondMachODetails: machODetails.replace(
					machOUuid,
					"87654321-4321-8765-CBA9-CBA987654321",
				),
				firstSignedDetails: `CDHash=${cdHash}`,
				secondSignedDetails: `CDHash=${cdHash}`,
				firstSignedRequirement: designatedRequirement,
				secondSignedRequirement: designatedRequirement,
			}),
		).toThrow("different LC_UUIDs");
	});

	test("requires deterministic v2 designated requirements", () => {
		expect(() =>
			validateVaultBrokerReproducibility({
				firstUnsignedHash: unsignedHash,
				secondUnsignedHash: unsignedHash,
				firstMachODetails: machODetails,
				secondMachODetails: machODetails,
				firstSignedDetails: `CDHash=${cdHash}`,
				secondSignedDetails: `CDHash=${cdHash}`,
				firstSignedRequirement: designatedRequirement,
				secondSignedRequirement: designatedRequirement.replace(
					"vault-broker.v2",
					"vault-broker.rewritten",
				),
			}),
		).toThrow("same designated requirement");
	});
});

describe("Vault Broker package continuity", () => {
	const requirement =
		`designated => identifier "${MACOS_VAULT_BROKER_IDENTIFIER}" ` +
		`and certificate leaf = H"${fingerprint}"`;

	test("accepts identical bytes, CDHash, and designated requirement", () => {
		expect(
			validateVaultBrokerContinuity({
				stagedDigest: unsignedHash,
				packagedDigest: unsignedHash,
				stagedDetails: `Executable=staged\nCDHash=${cdHash}`,
				packagedDetails: `Executable=packaged\nCDHash=${cdHash}`,
				stagedRequirement: requirement,
				packagedRequirement: requirement,
			}),
		).toBeUndefined();
	});

	test("rejects outer-signing rewrites of bytes, CDHash, or requirement", () => {
		const common = {
			stagedDigest: unsignedHash,
			packagedDigest: unsignedHash,
			stagedDetails: `CDHash=${cdHash}`,
			packagedDetails: `CDHash=${cdHash}`,
			stagedRequirement: requirement,
			packagedRequirement: requirement,
		};
		expect(() =>
			validateVaultBrokerContinuity({
				...common,
				packagedDigest: "d".repeat(64),
			}),
		).toThrow("bytes differ");
		expect(() =>
			validateVaultBrokerContinuity({
				...common,
				packagedDetails: `CDHash=${"E".repeat(40)}`,
			}),
		).toThrow("CDHash differs");
		expect(() =>
			validateVaultBrokerContinuity({
				...common,
				packagedRequirement: requirement.replace(
					MACOS_VAULT_BROKER_IDENTIFIER,
					"com.seago.whalehall.rewritten",
				),
			}),
		).toThrow("unexpected identifier");
	});
});
