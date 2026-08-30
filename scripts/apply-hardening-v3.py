from pathlib import Path

script = Path(__file__).with_name("apply-hardening-v2.py")
source = script.read_text()
old = '''cli = replace_once(
    cli,
    "  port: number;\\n  publicUrl: string | null;",
    "  port: number;\\n  transportMode: TransportMode;\\n  publicUrl: string | null;",
    "AdminInfo transport mode",
)'''
new = '''cli = replace_once(
    cli,
    "  workspaceRoot: string;\\n  port: number;\\n  publicUrl: string | null;",
    "  workspaceRoot: string;\\n  port: number;\\n  transportMode: TransportMode;\\n  publicUrl: string | null;",
    "AdminInfo transport mode",
)'''
if source.count(old) != 1:
    raise RuntimeError(f"expected one AdminInfo patch block, found {source.count(old)}")
source = source.replace(old, new, 1)
namespace = {"__file__": str(script), "__name__": "__main__"}
exec(compile(source, str(script), "exec"), namespace)
