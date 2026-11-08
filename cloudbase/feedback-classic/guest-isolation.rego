package authz.user

# Only anonymous visitors are affected. Existing authenticated users retain
# the platform defaults, except the new self-registration restriction below.
allow if {
    input.subject.auth_type == "anonymous"
    input.cloudbase.resource_type == "functions"
    input.request.path == "/v1/functions/lijin_feedback_v1"
}

deny contains "访客无权调用此云函数" if {
    input.subject.auth_type == "anonymous"
    input.cloudbase.resource_type == "functions"
    input.request.path != "/v1/functions/lijin_feedback_v1"
}

deny contains "访客无权使用此资源" if {
    input.subject.auth_type == "anonymous"
    input.cloudbase.resource_type in {"storages", "model", "rdb", "cloudrun", "ai", "aibot"}
}

# Email OTP was enabled only for an existing, pre-provisioned administrator.
# Block new HTTP API registrations; existing OTP sign-in uses token endpoints.
deny contains "此环境不开放自助注册" if {
    input.cloudbase.entrypoint_type == "tcbopenapi"
    input.subject.auth_type == "unauthenticated"
    input.request.path == "/auth/v1/signup"
}
