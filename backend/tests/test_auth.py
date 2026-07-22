from auth import AuthService

# Only exercises create_token/verify_token, which are pure (no Redis I/O)
# — bootstrap_user/verify_login need a real Redis connection and are
# covered by live verification instead (see DECISION_LOG.md), same
# approach as the rest of this backend's Redis-touching code.
SECRET = "a" * 32


def test_verify_token_accepts_its_own_valid_token():
    auth = AuthService("redis://fake:6379", SECRET)
    token = auth.create_token("admin")
    assert auth.verify_token(token) == "admin"


def test_verify_token_rejects_garbage():
    auth = AuthService("redis://fake:6379", SECRET)
    assert auth.verify_token("not-a-real-token") is None


def test_verify_token_rejects_token_signed_with_a_different_secret():
    issuer = AuthService("redis://fake:6379", SECRET)
    verifier = AuthService("redis://fake:6379", "b" * 32)
    token = issuer.create_token("admin")
    assert verifier.verify_token(token) is None
