// Stands in for the real `baw` in baw.test.ts. The first argument picks a behaviour, so each
// test can drive one reply shape without the real CLI or a Binance session.
const args = process.argv.slice(2);
const mode = args[0];
const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));

switch (mode) {
  case "echo":
    out({ success: true, data: { argv: args } });
    break;
  case "fail":
    out({
      success: false,
      error: { code: 351803, name: "AGENT_DEV_MODE_RISK_BLOCKED", message: "server text that must not be shown" },
    });
    process.exitCode = 1;
    break;
  case "fail-odd-code":
    out({ success: false, error: { code: "bad code; rm -rf /", name: "lower case name", message: "x" } });
    process.exitCode = 1;
    break;
  case "garbage":
    out("Update available! 1.10.1\n{\"success\":true,\"data\":{}}");
    break;
  case "no-data":
    out({ success: true });
    break;
  case "success-but-exit-1":
    out({ success: true, data: { ok: true } });
    process.exitCode = 1;
    break;
  case "slow":
    setTimeout(() => out({ success: true, data: {} }), 10_000);
    break;
  default:
    out({ success: false, error: { code: "UNKNOWN_MODE" } });
    process.exitCode = 1;
}
