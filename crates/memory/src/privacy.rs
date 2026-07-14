use crate::ProfilePayload;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum ProfilePrivacyClass {
    Normal,
    Sensitive,
    Secret,
}

pub fn classify_profile_privacy(text: &str) -> ProfilePrivacyClass {
    let lower = text.to_lowercase();
    if contains_any(
        &lower,
        &[
            "api_key",
            "api key",
            "access token",
            "refresh token",
            "bearer token",
            "private key",
            "seed phrase",
            "recovery phrase",
            "mnemonic phrase",
            "session cookie",
            "password is",
            "my password",
            "pin is",
            "cvv",
            "验证码",
            "我的密码",
            "密码是",
            "私钥",
            "助记词",
            "恢复短语",
            "访问令牌",
            "会话 cookie",
            "银行卡密码",
        ],
    ) || lower.contains("-----begin private key-----")
        || contains_prefixed_secret(&lower, "sk-")
    {
        ProfilePrivacyClass::Secret
    } else if contains_any(
        &lower,
        &[
            "medical",
            "health condition",
            "diagnosis",
            "medication",
            "government id",
            "passport number",
            "social security",
            "exact address",
            "home address",
            "bank account",
            "income",
            "salary",
            "biometric",
            "fingerprint",
            "criminal record",
            "legal case",
            "race",
            "ethnicity",
            "religion",
            "political affiliation",
            "sexual orientation",
            "trade union",
            "医疗",
            "健康状况",
            "诊断",
            "用药",
            "身份证号",
            "护照号",
            "精确住址",
            "家庭住址",
            "银行账户",
            "收入",
            "工资",
            "生物识别",
            "指纹",
            "犯罪记录",
            "法律案件",
            "种族",
            "民族",
            "宗教",
            "政治立场",
            "性取向",
            "工会",
        ],
    ) {
        ProfilePrivacyClass::Sensitive
    } else {
        ProfilePrivacyClass::Normal
    }
}

pub fn classify_profile_fact_privacy(
    evidence_text: &str,
    payload: &ProfilePayload,
) -> ProfilePrivacyClass {
    let payload_text = serde_json::to_string(payload).unwrap_or_default();
    classify_profile_privacy(evidence_text).max(classify_profile_privacy(&payload_text))
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn contains_prefixed_secret(text: &str, prefix: &str) -> bool {
    text.match_indices(prefix).any(|(index, _)| {
        text[index + prefix.len()..]
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '-')
            .count()
            >= 12
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PreferenceClaim;

    #[test]
    fn classifier_covers_the_frozen_privacy_policy() {
        assert_eq!(
            classify_profile_privacy("remember my password is abc"),
            ProfilePrivacyClass::Secret
        );
        assert_eq!(
            classify_profile_privacy("记住我的政治立场"),
            ProfilePrivacyClass::Sensitive
        );
        assert_eq!(
            classify_profile_privacy("记住我喜欢先看例子"),
            ProfilePrivacyClass::Normal
        );
    }

    #[test]
    fn payload_can_only_raise_the_evidence_privacy_class() {
        let payload = ProfilePayload::ExplanationPreference(PreferenceClaim {
            key: "account".into(),
            value: "my password is abc".into(),
        });
        assert_eq!(
            classify_profile_fact_privacy("remember this normal preference", &payload),
            ProfilePrivacyClass::Secret
        );
    }
}
