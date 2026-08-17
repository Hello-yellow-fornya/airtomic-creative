"""Guard the Modal deploy boundary.

`modal deploy` only creates functions that are registered on the app —
a missing @app.function decorator produces a deploy that *succeeds* while
the HTTP endpoint 500s on every request (transcribe.spawn resolves
nothing). This has broken in production; the registered-function list is
the ground truth, and this test pins it.

Run with: python -m pytest tests/  (needs `modal` installed, nothing else —
no Modal auth, no network).
"""

import importlib.util
from pathlib import Path

import modal

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_transcribe_module():
    spec = importlib.util.spec_from_file_location(
        "transcribe_mod", REPO_ROOT / "modal" / "transcribe.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_deployed_object_list_is_exactly_transcribe_and_api():
    mod = _load_transcribe_module()
    # This is the same list `modal deploy` prints. `transcribe` missing
    # here means the worker's submit call 500s; anything extra (e.g. a
    # decorated helper) means GPU containers spin up for in-process work.
    assert sorted(mod.app.registered_functions.keys()) == ["api", "transcribe"]


def test_transcribe_is_spawnable_gpu_function():
    mod = _load_transcribe_module()
    assert isinstance(mod.transcribe, modal.Function)
    assert hasattr(mod.transcribe, "spawn")


def test_diarise_is_a_plain_in_process_helper():
    # _diarise receives the raw audio array; making it a Modal function
    # would ship that across a container boundary per call.
    mod = _load_transcribe_module()
    assert not isinstance(mod._diarise, modal.Function)
