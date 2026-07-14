use memory::{MemoryStore, ReaderProfileSnapshot, SnapshotRequest};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProfileContextCacheKey {
    source_revision: u64,
    request: SnapshotRequest,
}

#[derive(Debug, Clone)]
struct CachedProfileContext {
    key: ProfileContextCacheKey,
    snapshot: ReaderProfileSnapshot,
}

#[derive(Debug, Default)]
pub struct ProfileContextCache {
    cached: Option<CachedProfileContext>,
    rebuilds: u64,
}

impl ProfileContextCache {
    pub fn snapshot<'a>(
        &'a mut self,
        store: &MemoryStore,
        request: &SnapshotRequest,
    ) -> &'a ReaderProfileSnapshot {
        let key = ProfileContextCacheKey {
            source_revision: store.projection_revision(),
            request: request.clone(),
        };
        if self.cached.as_ref().is_none_or(|cached| cached.key != key) {
            self.cached = Some(CachedProfileContext {
                key,
                snapshot: store.project_reader_profile_snapshot(request),
            });
            self.rebuilds = self.rebuilds.saturating_add(1);
        }
        &self
            .cached
            .as_ref()
            .expect("cache entry was installed")
            .snapshot
    }

    pub fn invalidate(&mut self) {
        self.cached = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use memory::{
        Applicability, CreateProfileFact, EvidenceRef, FactSource, PreferenceClaim, ProfilePayload,
        ProfileScope, Sensitivity, SnapshotContext,
    };
    use std::path::PathBuf;

    fn store(name: &str) -> (PathBuf, MemoryStore) {
        let dir = std::env::temp_dir().join(format!("ub-profile-cache-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.json");
        let store = MemoryStore::open(&path).unwrap();
        (path, store)
    }

    fn request() -> SnapshotRequest {
        SnapshotRequest::current(SnapshotContext {
            book_id: Some("book-a".into()),
            content_profile: Some("technical_learning".into()),
            ..Default::default()
        })
    }

    #[test]
    fn projection_revision_invalidates_cached_snapshot() {
        let (_path, mut store) = store("revision");
        let mut cache = ProfileContextCache::default();
        let first = cache.snapshot(&store, &request()).clone();
        assert_eq!(first.source_revision, 0);
        assert!(first.global_core.is_empty());

        store
            .create_profile_fact(
                CreateProfileFact {
                    scope: ProfileScope::Global,
                    applicability: Applicability::Any,
                    payload: ProfilePayload::ExplanationPreference(PreferenceClaim {
                        key: "depth".into(),
                        value: "detailed".into(),
                    }),
                    source: FactSource::UserStated,
                    evidence: vec![EvidenceRef::Turn {
                        session_id: "session".into(),
                        turn_id: "turn".into(),
                    }],
                    confidence: None,
                    sensitivity: Sensitivity::Normal,
                    valid_until: None,
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap();

        let second = cache.snapshot(&store, &request()).clone();
        assert_eq!(second.source_revision, 1);
        assert_eq!(second.global_core.len(), 1);
    }

    #[test]
    fn request_context_and_manual_invalidation_replace_cache_entry() {
        let (_path, store) = store("context");
        let mut cache = ProfileContextCache::default();
        cache.snapshot(&store, &request());
        cache.snapshot(&store, &request());
        assert_eq!(cache.rebuilds, 1);

        let mut different = request();
        different.context.book_id = Some("book-b".into());
        cache.snapshot(&store, &different);
        assert_eq!(cache.rebuilds, 2);

        cache.invalidate();
        assert!(cache.cached.is_none());
        cache.snapshot(&store, &different);
        assert_eq!(cache.rebuilds, 3);
    }
}
