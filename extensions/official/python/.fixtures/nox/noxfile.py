import nox

nox.options.sessions = ["tests", "lint"]


@nox.session(python=["3.11", "3.12"])
def tests(session):
    session.install("-e", ".[test]")
    session.run("pytest")


@nox.session
def lint(session):
    session.install("ruff")
    session.run("ruff", "check", ".")


@nox.session(name="type-check", reuse_venv=True)
def typecheck(session):
    session.install("mypy")
    session.run("mypy", ".")


@nox.session(
    python="3.12",
    venv_backend="uv",
)
@nox.parametrize("flag", ["a", "b"])
def docs(session, flag):
    session.run("mkdocs", "build")


def helper(session):
    pass
