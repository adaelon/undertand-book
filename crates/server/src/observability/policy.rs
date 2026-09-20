pub fn safe_purpose(value: &str) -> String {
    match value {
        "outer" | "query" | "synthesize" | "selection" | "profile" | "compaction" | "repair" => {
            value.to_owned()
        }
        _ => "unknown".into(),
    }
}

pub fn safe_tool_name(value: &str) -> String {
    if runtime::orchestrator::is_registered_resident_tool(value) {
        value.to_owned()
    } else {
        "unknown_tool".into()
    }
}

pub fn safe_error_code(value: Option<&str>) -> Option<String> {
    value.map(|code| {
        if !code.is_empty()
            && code.len() <= 64
            && code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        {
            code.to_owned()
        } else {
            "UNKNOWN_ERROR".into()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_replaces_unregistered_names_and_non_codes() {
        assert_eq!(safe_tool_name("CANARY_PRIVATE_ARGUMENT"), "unknown_tool");
        assert_eq!(
            safe_error_code(Some("provider said CANARY_PRIVATE_BODY")),
            Some("UNKNOWN_ERROR".into())
        );
        assert_eq!(safe_purpose("CANARY_PRIVATE_PURPOSE"), "unknown");
    }
}
