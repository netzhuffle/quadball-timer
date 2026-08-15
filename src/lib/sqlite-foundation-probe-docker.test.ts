import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import {
  buildDockerContainerArguments,
  buildFocusedDockerCommand,
  admitDockerEngine,
  cleanupMalformedCreateOutput,
  createDockerProbeExecution,
  DockerAdmissionError,
  isOwnedDockerContainerInspection,
  isDockerResourceViolation,
  isDockerContainerConfigurationAdmitted,
  SQLITE_FOUNDATION_PROBE_DOCKER_INFO_IDENTITY_FORMAT,
  SQLITE_FOUNDATION_PROBE_DOCKER_VERSION_IDENTITY_FORMAT,
  parseDockerEngineIdentity,
  parseDockerArtifactIdentity,
  parseDockerResourceMeasurement,
  parseContainerId,
  verifyOwnedDockerContainerAbsence,
} from "@/lib/sqlite-foundation-probe-docker";

const capability = "00000000-0000-0000-0000-000000000000";
const containerId = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function admittedContainerInspection(artifactPath: string): string {
  return JSON.stringify({
    Id: containerId,
    Name: `/quadball-timer-sqlite-${capability}`,
    Config: {
      Labels: { ["com.quadball-timer.sqlite-probe"]: capability },
      User: "65532:65532",
      WorkingDir: "/tmp",
      Env: ["LANG=C", "LC_ALL=C", "NODE_ENV=test", "NO_COLOR=1", "TMPDIR=/tmp", "TZ=UTC"],
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Memory: 512 * 1024 * 1024,
      PidsLimit: 8,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PidMode: "",
      IpcMode: "private",
      UsernsMode: "",
      CgroupnsMode: "private",
      CgroupParent: "",
      Devices: null,
      DeviceRequests: null,
      LogConfig: { Type: "json-file", Config: { "max-size": "4k", "max-file": "1" } },
      Tmpfs: { "/tmp": "rw,size=16777216,mode=1777" },
    },
    Mounts: [
      { Type: "tmpfs", Destination: "/tmp", RW: true },
      {
        Type: "bind",
        Source: artifactPath,
        Destination: "/opt/quadball-timer",
        RW: false,
      },
    ],
  });
}

function ownedContainerInspection(): string {
  return JSON.stringify({
    Id: containerId,
    Name: `/quadball-timer-sqlite-${capability}`,
    Config: { Labels: { ["com.quadball-timer.sqlite-probe"]: capability } },
  });
}

describe("Docker SQLite qualification boundary", () => {
  test("constructs one non-privileged, no-network, bounded container", () => {
    const command = buildDockerContainerArguments({
      name: "quadball-timer-sqlite-test",
      capability,
      artifactPath: "/release/quadball-timer",
      command: ["/opt/quadball-timer", "--sqlite-foundation-probe"],
    });
    expect(command).toContain("--network");
    expect(command).toContain("none");
    expect(command).toContain("--read-only");
    expect(command).toContain("--cap-drop");
    expect(command).toContain("ALL");
    expect(command).toContain("--security-opt");
    expect(command).toContain("no-new-privileges:true");
    expect(command).toContain("--pids-limit");
    expect(command).toContain("8");
    expect(command.join(" ")).toContain("size=16777216");
    expect(command).toContain("--log-driver");
    expect(command).toContain("json-file");
    expect(command).toContain("max-size=4k");
    expect(command).toContain("max-file=1");
    expect(command.join(" ")).not.toContain("--privileged");
    expect(command.join(" ")).not.toContain("host");
  });

  test("requires an unambiguous native Linux amd64 engine", () => {
    const info = JSON.stringify({ OSType: "linux", Architecture: "x86_64" });
    const version = JSON.stringify({ Os: "linux", Arch: "amd64" });
    expect(parseDockerEngineIdentity(info, version)).toEqual({
      os: "linux",
      serverArchitecture: "amd64",
      hostArchitecture: "x86_64",
    });
    expect(parseDockerEngineIdentity(info, JSON.stringify({ Os: "linux" }))).toBeNull();
    expect(
      parseDockerEngineIdentity(
        JSON.stringify({ OSType: "darwin", Architecture: "arm64" }),
        version,
      ),
    ).toBeNull();
    expect(parseDockerEngineIdentity("not-json", version)).toBeNull();
  });

  test("accepts only the exact pinned artifact identity", () => {
    const output = JSON.stringify({
      artifactIdentity: {
        os: "linux",
        architecture: "x64",
        bunVersion: "1.3.14",
        bunRevision: "abcdef12",
        sqliteVersion: "3.53.0",
      },
    });
    expect(parseDockerArtifactIdentity(output, "1.3.14")?.bunRevision).toBe("abcdef12");
    expect(parseDockerArtifactIdentity(output.replace("1.3.14", "1.3.13"), "1.3.14")).toBeNull();
    expect(parseDockerArtifactIdentity(output.replace("abcdef12", "unknown"), "1.3.14")).toBeNull();
    expect(parseDockerArtifactIdentity(output.replace("3.53.0", "3.51.2"), "1.3.14")).toBeNull();
  });

  test("requires the complete Docker containment configuration before start", () => {
    const inspection = JSON.stringify({
      Id: containerId,
      Name: "/owned",
      Config: {
        Labels: { "com.quadball-timer.sqlite-probe": capability },
        User: "65532:65532",
        WorkingDir: "/tmp",
        Env: ["LANG=C", "LC_ALL=C", "NODE_ENV=test", "NO_COLOR=1", "TMPDIR=/tmp", "TZ=UTC"],
      },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Memory: 512 * 1024 * 1024,
        PidsLimit: 8,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Privileged: false,
        PidMode: "",
        IpcMode: "private",
        UsernsMode: "",
        CgroupnsMode: "private",
        CgroupParent: "",
        Devices: null,
        DeviceRequests: null,
        LogConfig: { Type: "json-file", Config: { "max-size": "4k", "max-file": "1" } },
        Tmpfs: { "/tmp": "rw,size=16777216,mode=1777" },
      },
      Mounts: [
        { Type: "tmpfs", Destination: "/tmp", RW: true },
        {
          Type: "bind",
          Source: "/release/quadball-timer",
          Destination: "/opt/quadball-timer",
          RW: false,
        },
      ],
    });
    expect(
      isDockerContainerConfigurationAdmitted(
        inspection,
        containerId,
        "owned",
        capability,
        "/release/quadball-timer",
      ),
    ).toBe(true);
    expect(
      isDockerContainerConfigurationAdmitted(
        inspection.replace('"ReadonlyRootfs":true', '"ReadonlyRootfs":false'),
        containerId,
        "owned",
        capability,
        "/release/quadball-timer",
      ),
    ).toBe(false);
    expect(
      isDockerContainerConfigurationAdmitted(
        inspection.replace('"CapDrop":["ALL"]', '"CapDrop":["ALL"],"CapAdd":["NET_ADMIN"]'),
        containerId,
        "owned",
        capability,
        "/release/quadball-timer",
      ),
    ).toBe(false);
    for (const [field, value] of [
      ["Privileged", true],
      ["PidMode", "host"],
      ["IpcMode", "host"],
      ["UsernsMode", "host"],
      ["CgroupnsMode", "host"],
      ["CgroupParent", "/delegated"],
      ["Devices", [{ PathOnHost: "/dev/null" }]],
      ["DeviceRequests", [{ Driver: "nvidia" }]],
      ["LogConfig", { Type: "json-file", Config: { "max-size": "8k", "max-file": "1" } }],
    ] as const) {
      const mutated = JSON.parse(inspection);
      mutated.HostConfig[field] = value;
      expect(
        isDockerContainerConfigurationAdmitted(
          JSON.stringify(mutated),
          containerId,
          "owned",
          capability,
          "/release/quadball-timer",
        ),
      ).toBe(false);
    }
  });

  test("fails the start barrier before the artifact can run", async () => {
    const artifactPath = await realpath("/bin/sh");
    const calls: string[][] = [];
    const responses = [
      { exitCode: 0, stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }) },
      { exitCode: 0, stdout: JSON.stringify({ Os: "linux", Arch: "amd64" }) },
      { exitCode: 0, stdout: `${containerId}\n` },
      { exitCode: 0, stdout: "{}" },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          Id: containerId,
          Name: `/quadball-timer-sqlite-${capability}`,
          Config: { Labels: { ["com.quadball-timer.sqlite-probe"]: capability } },
        }),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    ];
    const error = await createDockerProbeExecution(artifactPath, {
      platform: "linux",
      architecture: "x64",
      invocationId: capability,
      runCommand: async (arguments_) => {
        calls.push([...arguments_]);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected Docker command");
        return {
          ...response,
          stderr: "",
          stdoutBytes: response.stdout.length,
          stderrBytes: 0,
          outputExceeded: false,
        };
      },
    }).catch((value) => value);
    expect(error).toBeInstanceOf(DockerAdmissionError);
    expect((error as DockerAdmissionError).disposition).toBe("removed");
    expect(calls.map((value) => value[0])).toEqual([
      "info",
      "version",
      "create",
      "inspect",
      "inspect",
      "rm",
      "ps",
    ]);
    expect(calls[2]).toContain(`type=bind,src=${artifactPath},dst=/opt/quadball-timer,readonly`);
    expect(calls.map((value) => value[0])).not.toContain("start");
  });

  test("uses production stop, kill, wait, removal, and exact absence in order", async () => {
    const artifactPath = await realpath("/bin/sh");
    const calls: string[] = [];
    let inspectCount = 0;
    const response = (stdout = "", exitCode = 0) => ({
      exitCode,
      stdout,
      stderr: "",
      stdoutBytes: stdout.length,
      stderrBytes: 0,
      outputExceeded: false,
    });
    const execution = await createDockerProbeExecution(artifactPath, {
      platform: "linux",
      architecture: "x64",
      invocationId: capability,
      runCommand: async (arguments_) => {
        const command = arguments_[0] ?? "";
        calls.push(command);
        if (command === "info")
          return response(JSON.stringify({ OSType: "linux", Architecture: "x86_64" }));
        if (command === "version") return response(JSON.stringify({ Os: "linux", Arch: "amd64" }));
        if (command === "create") return response(`${containerId}\n`);
        if (command === "inspect") {
          if (inspectCount++ === 0) return response(admittedContainerInspection(artifactPath));
          return response(ownedContainerInspection());
        }
        if (command === "stop") return response("", 1);
        if (command === "kill") return response();
        if (command === "wait") return response("137\n");
        if (command === "rm") return response();
        if (command === "ps") return response();
        throw new Error(`unexpected Docker command: ${arguments_.join(" ")}`);
      },
    });
    await execution.stop();
    const cleanup = await execution.cleanup();
    expect(cleanup).toMatchObject({
      identityVerified: true,
      removed: true,
      descendantsTerminated: true,
      descendantsReaped: true,
    });
    expect(calls.slice(-6)).toEqual(["stop", "kill", "wait", "inspect", "rm", "ps"]);
  });

  test("uses bounded plain logs for successful and failed workloads", async () => {
    const artifactPath = await realpath("/bin/sh");
    const makeExecution = async (waitExitCode: number, logsExitCode = 0, logStderr = "") => {
      const commands: string[][] = [];
      let inspectCount = 0;
      const response = (stdout = "", exitCode = 0, stderr = "") => ({
        exitCode,
        stdout,
        stderr,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        outputExceeded: false,
      });
      const execution = await createDockerProbeExecution(artifactPath, {
        platform: "linux",
        architecture: "x64",
        invocationId: capability,
        expectedBunVersion: "1.3.14",
        runCommand: async (arguments_) => {
          commands.push([...arguments_]);
          const command = arguments_[0] ?? "";
          if (command === "info")
            return response(JSON.stringify({ OSType: "linux", Architecture: "x86_64" }));
          if (command === "version")
            return response(JSON.stringify({ Os: "linux", Arch: "amd64" }));
          if (command === "create") return response(`${containerId}\n`);
          if (command === "inspect") {
            if (inspectCount++ === 0) return response(admittedContainerInspection(artifactPath));
            return response(ownedContainerInspection());
          }
          if (command === "start") return response();
          if (command === "wait") return response(`${waitExitCode}\n`);
          if (command === "stats")
            return response(JSON.stringify({ PIDs: "1", MemUsage: "1MiB / 512MiB" }));
          if (command === "logs")
            return response(
              JSON.stringify({
                artifactIdentity: {
                  os: "linux",
                  architecture: "x64",
                  bunVersion: "1.3.14",
                  bunRevision: "abcdef12",
                  sqliteVersion: "3.53.0",
                },
              }),
              logsExitCode,
              logStderr,
            );
          throw new Error(`unexpected Docker command: ${arguments_.join(" ")}`);
        },
      });
      return { execution, commands };
    };

    const success = await makeExecution(0);
    await expect(success.execution.run()).resolves.toMatchObject({ exitCode: 0 });
    expect(success.commands.find((value) => value[0] === "logs")).toEqual(["logs", containerId]);

    const failure = await makeExecution(1);
    await expect(failure.execution.run()).rejects.toMatchObject({ result: { exitCode: 1 } });
    expect(failure.commands.find((value) => value[0] === "logs")).toEqual(["logs", containerId]);

    const logFailure = await makeExecution(0, 1, "logs unavailable");
    await expect(logFailure.execution.run()).rejects.toMatchObject({
      result: { stderr: "logs unavailable", stderrBytes: 16 },
    });

    const enospc = await makeExecution(0, 1, "ENOSPC");
    await expect(enospc.execution.run()).rejects.toMatchObject({
      measurement: { diskBytes: null, resourceViolations: ["disk-lower-bound"] },
      result: { stderr: "ENOSPC", stderrBytes: 6 },
    });
  });

  test("admits a reachable engine only once and fails closed on unavailable output", async () => {
    const calls: string[][] = [];
    const identity = await admitDockerEngine({
      platform: "linux",
      architecture: "x64",
      runCommand: async (arguments_) => {
        calls.push([...arguments_]);
        return {
          exitCode: 0,
          stdout:
            arguments_[0] === "info"
              ? JSON.stringify({ OSType: "linux", Architecture: "x86_64" })
              : JSON.stringify({ Os: "linux", Arch: "amd64" }),
          stderr: "",
          stdoutBytes: 64,
          stderrBytes: 0,
          outputExceeded: false,
        };
      },
    });
    expect(identity.serverArchitecture).toBe("amd64");
    expect(calls.map((value) => value[0])).toEqual(["info", "version"]);
    await expect(
      admitDockerEngine({
        platform: "linux",
        architecture: "x64",
        runCommand: async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputExceeded: false,
        }),
      }),
    ).rejects.toBeInstanceOf(DockerAdmissionError);
    await expect(
      admitDockerEngine({
        platform: "linux",
        architecture: "x64",
        runCommand: async () => ({
          exitCode: 0,
          stdout: "{}",
          stderr: "",
          stdoutBytes: 4,
          stderrBytes: 0,
          outputExceeded: true,
        }),
      }),
    ).rejects.toBeInstanceOf(DockerAdmissionError);
  });

  test("keeps oversized full info outside the reader while accepting bounded identity output", async () => {
    const oversizedInfo = JSON.stringify({
      OSType: "linux",
      Architecture: "x86_64",
      diagnostics: "x".repeat(10_422),
    });
    const boundedInfo = JSON.stringify({ OSType: "linux", Architecture: "x86_64" });
    const boundedVersion = JSON.stringify({ Os: "linux", Arch: "amd64" });
    expect(new TextEncoder().encode(oversizedInfo).byteLength).toBeGreaterThan(4 * 1024);
    expect(new TextEncoder().encode(boundedInfo).byteLength).toBeLessThan(4 * 1024);
    expect(new TextEncoder().encode(boundedVersion).byteLength).toBeLessThan(4 * 1024);

    await expect(
      admitDockerEngine({
        platform: "linux",
        architecture: "x64",
        runCommand: async (arguments_) => ({
          exitCode: 0,
          stdout: arguments_[0] === "info" ? oversizedInfo : boundedVersion,
          stderr: "",
          stdoutBytes: arguments_[0] === "info" ? oversizedInfo.length : boundedVersion.length,
          stderrBytes: 0,
          outputExceeded: arguments_[0] === "info",
        }),
      }),
    ).rejects.toBeInstanceOf(DockerAdmissionError);

    const calls: string[][] = [];
    await expect(
      admitDockerEngine({
        platform: "linux",
        architecture: "x64",
        runCommand: async (arguments_) => {
          calls.push([...arguments_]);
          const stdout = arguments_[0] === "info" ? boundedInfo : boundedVersion;
          return {
            exitCode: 0,
            stdout,
            stderr: "",
            stdoutBytes: stdout.length,
            stderrBytes: 0,
            outputExceeded: false,
          };
        },
      }),
    ).resolves.toEqual({
      os: "linux",
      serverArchitecture: "amd64",
      hostArchitecture: "x86_64",
    });
    expect(calls).toEqual([
      ["info", "--format", SQLITE_FOUNDATION_PROBE_DOCKER_INFO_IDENTITY_FORMAT],
      ["version", "--format", SQLITE_FOUNDATION_PROBE_DOCKER_VERSION_IDENTITY_FORMAT],
    ]);
    expect(parseDockerEngineIdentity(boundedInfo, boundedVersion)).not.toBeNull();
    expect(
      parseDockerEngineIdentity(JSON.stringify({ OSType: "linux" }), boundedVersion),
    ).toBeNull();
    expect(
      parseDockerEngineIdentity(boundedInfo, JSON.stringify({ Os: "linux", Arch: "arm64" })),
    ).toBeNull();
  });

  test("keeps the focused command harmless and separate from the SQLite workload", () => {
    const command = buildFocusedDockerCommand("focused", capability);
    expect(command).not.toContain("--mount");
    expect(command.join(" ")).not.toContain("sqlite-foundation-probe");
    expect(command.join(" ")).toContain("test ! -w /etc");
  });

  test("parses Docker resource output without fabricating unavailable disk data", () => {
    const measurement = parseDockerResourceMeasurement(
      [
        JSON.stringify({ PIDs: "4", MemUsage: "8MiB / 512MiB" }),
        JSON.stringify({ PIDs: "8", MemUsage: "12.5MiB / 512MiB" }),
      ].join("\n"),
      { stdout: "", stdoutBytes: 10 },
      { stderr: "", stderrBytes: 4 },
    );
    expect(measurement).toEqual({
      processCount: 7,
      peakMemoryBytes: 13_107_200,
      diskBytes: null,
      outputBytes: 14,
      resourceViolations: [],
    });
    const short = parseDockerResourceMeasurement(
      "",
      { stdout: "", stdoutBytes: 0 },
      { stderr: "", stderrBytes: 0 },
    );
    expect(short.processCount).toBeNull();
    expect(short.peakMemoryBytes).toBeNull();
    expect(
      isDockerResourceViolation(
        short,
        { stdout: "", outputExceeded: false },
        { stderr: "", outputExceeded: false },
      ),
    ).toBe(false);
    const enospc = parseDockerResourceMeasurement(
      "",
      { stdoutBytes: 0, stdout: "" },
      { stderrBytes: 10, stderr: "ENOSPC" },
    );
    expect(enospc.diskBytes).toBeNull();
    expect(enospc.resourceViolations).toEqual(["disk-lower-bound"]);
    expect(
      isDockerResourceViolation(
        enospc,
        { stdout: "", outputExceeded: false },
        { stderr: "ENOSPC", outputExceeded: false },
      ),
    ).toBe(true);
    expect(
      isDockerResourceViolation(
        { processCount: 8, peakMemoryBytes: null, diskBytes: null, outputBytes: 0 },
        { stdout: "", outputExceeded: false },
        { stderr: "", outputExceeded: false },
      ),
    ).toBe(true);
    expect(
      isDockerResourceViolation(
        {
          processCount: null,
          peakMemoryBytes: 512 * 1024 * 1024 + 1,
          diskBytes: null,
          outputBytes: 0,
        },
        { stdout: "", outputExceeded: false },
        { stderr: "", outputExceeded: false },
      ),
    ).toBe(true);
    expect(
      isDockerResourceViolation(
        { processCount: null, peakMemoryBytes: null, diskBytes: null, outputBytes: 0 },
        { stdout: "", outputExceeded: true },
        { stderr: "", outputExceeded: false },
      ),
    ).toBe(true);
  });

  test("accepts only Docker-shaped container IDs", () => {
    expect(parseContainerId(`${containerId}\n`)).toBe(containerId);
    expect(parseContainerId("0123456789abcdef")).toBeNull();
    expect(parseContainerId("untrusted id")).toBeNull();
  });

  test("removes only an exact owned container identity", () => {
    const inspection = JSON.stringify({
      Id: containerId,
      Name: "/owned",
      Config: { Labels: { "com.quadball-timer.sqlite-probe": capability } },
    });
    expect(isOwnedDockerContainerInspection(inspection, containerId, "owned", capability)).toBe(
      true,
    );
    expect(isOwnedDockerContainerInspection(inspection, containerId, "other", capability)).toBe(
      false,
    );
    expect(isOwnedDockerContainerInspection(inspection, containerId, "owned", "other")).toBe(false);
    expect(
      isOwnedDockerContainerInspection(
        inspection,
        `${containerId.slice(0, 12)}`,
        "owned",
        capability,
      ),
    ).toBe(false);
  });

  test("requires successful exact absence evidence after removal", async () => {
    expect(
      await verifyOwnedDockerContainerAbsence(
        async () => ({
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputExceeded: false,
        }),
        containerId,
      ),
    ).toBe(true);
    expect(
      await verifyOwnedDockerContainerAbsence(
        async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "daemon unavailable",
          stdoutBytes: 0,
          stderrBytes: 18,
          outputExceeded: false,
        }),
        containerId,
      ),
    ).toBe(false);
    expect(
      await verifyOwnedDockerContainerAbsence(
        async () => ({
          exitCode: 0,
          stdout: `${containerId}\n`,
          stderr: "",
          stdoutBytes: 65,
          stderrBytes: 0,
          outputExceeded: false,
        }),
        containerId,
      ),
    ).toBe(false);
  });

  test("discovers and verifies cleanup after malformed Docker create output", async () => {
    const artifactPath = await realpath("/bin/sh");
    const calls: string[][] = [];
    const executionId = containerId;
    const responses = [
      { exitCode: 0, stdout: JSON.stringify({ OSType: "linux", Architecture: "x86_64" }) },
      { exitCode: 0, stdout: JSON.stringify({ Os: "linux", Arch: "amd64" }) },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: `${executionId}\n` },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          Id: executionId,
          Name: `/quadball-timer-sqlite-${capability}`,
          Config: { Labels: { ["com.quadball-timer.sqlite-probe"]: capability } },
        }),
      },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    ];
    const error = await createDockerProbeExecution(artifactPath, {
      platform: "linux",
      architecture: "x64",
      invocationId: capability,
      runCommand: async (arguments_) => {
        calls.push([...arguments_]);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected Docker command");
        return {
          ...response,
          stderr: "",
          stdoutBytes: response.stdout.length,
          stderrBytes: 0,
          outputExceeded: false,
        };
      },
    }).catch((value) => value);
    expect(error).toBeInstanceOf(DockerAdmissionError);
    expect((error as DockerAdmissionError).disposition).toBe("removed");
    expect(calls.map((value) => value[0])).toEqual([
      "info",
      "version",
      "create",
      "ps",
      "inspect",
      "rm",
      "ps",
    ]);
  });

  test("does not clean up from failed or ambiguous discovery output", async () => {
    const commandNames: string[] = [];
    const failed = await cleanupMalformedCreateOutput(
      async (arguments_) => {
        commandNames.push(arguments_[0] ?? "");
        return {
          exitCode: 1,
          stdout: containerId,
          stderr: "daemon unavailable",
          stdoutBytes: 64,
          stderrBytes: 18,
          outputExceeded: false,
        };
      },
      "owned",
      capability,
    );
    expect(failed).toBe("unverified");
    expect(commandNames).toEqual(["ps"]);
  });
});
