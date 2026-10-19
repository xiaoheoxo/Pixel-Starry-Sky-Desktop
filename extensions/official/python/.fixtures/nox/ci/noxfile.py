from nox import session


@session
def build(s):
    s.run("python", "-m", "build")
