//! A byte-bounded observation buffer; socket writes never own the buffer or AppState lock.
use runtime::run_events::{RunActivity, RunEventSink, RuntimeEvent};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const EVENT_BYTES: usize = 256 * 1024;
#[derive(Debug, Clone, Serialize)]
pub struct RunDescriptor { pub book_id: String, pub session_id: String, pub turn_id: String }
#[derive(Debug, Clone, Serialize)]
pub struct RunSnapshot {
    pub descriptor: RunDescriptor,
    pub last_seq: u64,
    pub execution_state: String,
    pub persistence_state: String,
    pub activities: Vec<RunActivity>,
    pub reader_state: Option<Value>,
    pub effects: Vec<Value>,
    pub draft: Option<runtime::answer_stream::AnswerPatch>,
    pub final_view: Option<Value>,
    pub error: Option<Value>,
}
#[derive(Clone, Serialize)]
pub struct RunEvent {
    pub turn_id: String,
    pub seq: u64,
    pub elapsed_ms: f64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
}
struct Buffer { bindings: Vec<runtime::orchestrator::SourceBinding>, snapshot: RunSnapshot, events: VecDeque<(RunEvent, usize)>, bytes: usize }
pub struct RunStream { start: Instant, buffer: Mutex<Buffer>, changed: Condvar, byte_limit: usize }
impl RunStream {
    pub fn new(descriptor: RunDescriptor) -> Arc<Self> {
        let stream = Self::from_snapshot(RunSnapshot { descriptor, last_seq: 0, execution_state: "running".into(), persistence_state: "pending".into(), activities: Vec::new(), reader_state: None, effects: Vec::new(), draft: None, final_view: None, error: None });
        stream.update("run.started", |_| (), |s| json!(s.descriptor));
        stream
    }
    pub fn from_snapshot(snapshot: RunSnapshot) -> Arc<Self> {
        Arc::new(Self { start: Instant::now(), buffer: Mutex::new(Buffer { bindings: Vec::new(), snapshot, events: VecDeque::new(), bytes: 0 }), changed: Condvar::new(), byte_limit: EVENT_BYTES })
    }
    pub fn source_binding(&self, book_id: &str, turn_id: &str, ref_id: &str) -> Option<runtime::orchestrator::SourceBinding> {
        let buffer = self.buffer.lock().unwrap();
        let s = &buffer.snapshot;
        if s.persistence_state != "pending" || s.descriptor.book_id != book_id || s.descriptor.turn_id != turn_id { return None; }
        let published = s.draft.as_ref()?.view.as_ref()?.sources.iter().any(|source| source.source_ref_id == ref_id);
        published.then(|| buffer.bindings.iter().find(|b| b.source_ref_id == ref_id).cloned()).flatten()
    }
    pub fn snapshot(&self) -> RunSnapshot { self.buffer.lock().unwrap().snapshot.clone() }
    fn update(&self, kind: &str, apply: impl FnOnce(&mut RunSnapshot), payload: impl FnOnce(&RunSnapshot) -> Value) {
        let mut buffer = self.buffer.lock().unwrap();
        if kind == "run.cancelling" && buffer.snapshot.execution_state != "running" { return; }
        apply(&mut buffer.snapshot);
        buffer.snapshot.last_seq += 1;
        let event = RunEvent { turn_id: buffer.snapshot.descriptor.turn_id.clone(), seq: buffer.snapshot.last_seq, elapsed_ms: self.start.elapsed().as_secs_f64() * 1000.0, event_type: kind.into(), payload: payload(&buffer.snapshot) };
        let bytes = serde_json::to_vec(&event).unwrap().len();
        buffer.bytes += bytes;
        buffer.events.push_back((event, bytes));
        while buffer.bytes > self.byte_limit { if let Some((_, bytes)) = buffer.events.pop_front() { buffer.bytes -= bytes; } }
        self.changed.notify_all();
    }
    pub fn reader_changed(&self, state: Value) {
        self.update("reader.changed", |s| s.reader_state = Some(state.clone()), |_| state.clone());
    }
    pub fn cancelling(&self) {
        // The coordinator serializes stop requests. Finalizing/terminal runs keep their actual state.
        self.update("run.cancelling", |s| s.execution_state = "cancelling".into(), |_| Value::Null);
    }
    pub fn finalizing(&self) { self.update("run.finalizing", |s| s.execution_state = "finalizing".into(), |_| Value::Null); }
    pub fn finish(&self, view: Option<Value>, error: Option<Value>) {
        let (kind, execution, persistence) = if error.is_some() { ("run.persistence_failed", "ended", "failed") }
            else { match view.as_ref().and_then(|v| v["status"].as_str()) {
                Some("cancelled") => ("run.cancelled", "cancelled", "saved"),
                Some("failed") => ("run.failed", "failed", "saved"),
                _ => ("run.completed", "completed", "saved"),
            }};
        // Called after the history commit: only this boundary can finalize a draft.
        let previous = self.snapshot().draft;
        let canonical = if error.is_none() { view.as_ref().and_then(|v| serde_json::from_value(v["outcome"]["answer_view"].clone()).ok()) } else { None };
        let patch = runtime::answer_stream::AnswerPatch {
            message_id: previous.as_ref().map_or(0, |p| p.message_id),
            revision: previous.as_ref().map_or(0, |p| p.revision),
            operation: if execution == "completed" { "finalize" } else { "discard" }.into(), view: canonical,
        };
        self.answer_patch(patch);
        self.update(kind, |s| { s.execution_state = execution.into(); s.persistence_state = persistence.into(); s.draft = None; s.final_view = view; s.error = error; }, |s| json!(s));
    }
    /// Selection of snapshot(N) and cursor N occurs under the same mutex as publication.
    pub fn read_after(&self, after: Option<u64>, wait: Duration) -> (Vec<RunEvent>, bool) {
        let mut buffer = self.buffer.lock().unwrap();
        if after == Some(buffer.snapshot.last_seq) && buffer.snapshot.persistence_state == "pending" {
            buffer = self.changed.wait_timeout(buffer, wait).unwrap().0;
        }
        let snapshot = &buffer.snapshot;
        let terminal = snapshot.persistence_state != "pending";
        let covered = after.is_some_and(|seq| seq <= snapshot.last_seq &&
            (seq == snapshot.last_seq || buffer.events.front().is_some_and(|(first, _)| seq + 1 >= first.seq)));
        let events = if covered {
            buffer.events.iter().filter(|(event, _)| event.seq > after.unwrap()).map(|(event, _)| event.clone()).collect()
        } else { vec![RunEvent { turn_id: snapshot.descriptor.turn_id.clone(), seq: snapshot.last_seq,
            elapsed_ms: self.start.elapsed().as_secs_f64() * 1000.0, event_type: "run.snapshot".into(), payload: json!(snapshot) }] };
        (events, terminal)
    }
}
impl RunEventSink for RunStream {
    fn effect_created(&self, step_id: u32, effect: &runtime::orchestrator::AgentEffect) {
        self.update("effect.created", |s| {
            let id = format!("{}:{step_id}", s.descriptor.turn_id);
            if !s.effects.iter().any(|e| e["effect_id"] == id) { s.effects.push(json!({"effect_id":id, "effect":effect})); }
        }, |s| s.effects.last().cloned().unwrap_or(Value::Null));
    }
    fn source_bindings(&self, bindings: &[runtime::orchestrator::SourceBinding]) { self.buffer.lock().unwrap().bindings = bindings.to_vec(); }
    fn answer_patch(&self, patch: runtime::answer_stream::AnswerPatch) {
        self.update("answer.patch", |s| { if s.persistence_state == "pending" { s.draft = runtime::answer_stream::apply_patch(s.draft.as_ref(), &patch); } }, |_| json!(patch));
    }

    fn emit(&self, event: RuntimeEvent) {
        let activity = event.activity;
        let phase = if activity.status == runtime::run_events::ActivityStatus::Running { "started" } else { "finished" };
        let kind = format!("{}.{}", activity.kind, phase);
        self.update(&kind, |s| {
            if let Some(old) = s.activities.iter_mut().find(|a| a.step_id == activity.step_id) { *old = activity.clone(); }
            else { s.activities.push(activity.clone()); }
        }, |_| json!(activity));
    }
}

pub fn serve(request: tiny_http::Request, stream: Arc<RunStream>, mut after: Option<u64>) {
    std::thread::spawn(move || {
        let mut writer = request.into_writer();
        let result = (|| -> std::io::Result<()> {
            writer.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nX-Accel-Buffering: no\r\nConnection: close\r\n\r\n")?;
            writer.flush()?;
            loop {
                let (events, terminal) = stream.read_after(after, Duration::from_secs(10));
                if events.is_empty() { writer.write_all(b": keepalive\n\n")?; }
                for event in events {
                    write!(writer, "id: {}\nevent: {}\ndata: {}\n\n", event.seq, event.event_type, serde_json::to_string(&event).unwrap())?;
                    after = Some(event.seq);
                }
                writer.flush()?;
                if terminal { return Ok(()); }
            }
        })();
        let _ = result; // A disconnected observer never cancels or restarts execution.
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn draft_snapshot_repair_and_commit_boundary_are_atomic() {
        use runtime::answer_stream::AnswerPatch;
        use runtime::orchestrator::{AgentAnswerPart, AgentAnswerView};
        let stream = RunStream::new(RunDescriptor { book_id:"book".into(), session_id:"session".into(), turn_id:"turn".into() });
        let view = AgentAnswerView { parts:vec![AgentAnswerPart::Markdown { text:"草稿。".into() }], sources:vec![] };
        stream.answer_patch(AnswerPatch { message_id:1, revision:0, operation:"replace".into(), view:Some(view.clone()) });
        stream.answer_patch(AnswerPatch { message_id:1, revision:0, operation:"append".into(), view:Some(AgentAnswerView { parts:vec![AgentAnswerPart::Markdown { text:"补充。".into() }], sources:vec![] }) });
        assert_eq!(stream.snapshot().draft.as_ref().unwrap().view.as_ref().unwrap().parts.len(), 1);
        stream.answer_patch(AnswerPatch { message_id:1, revision:0, operation:"replace".into(), view:Some(view.clone()) });
        let (snapshot, _) = stream.read_after(None, Duration::ZERO);
        assert_eq!(snapshot[0].payload["draft"]["view"], json!(view));
        stream.answer_patch(AnswerPatch { message_id:1, revision:1, operation:"replace".into(), view:None });
        assert!(stream.snapshot().draft.unwrap().view.is_none());
        let cursor = stream.snapshot().last_seq;
        stream.finalizing();
        let (before_commit, _) = stream.read_after(Some(cursor), Duration::ZERO);
        assert!(before_commit.iter().all(|e| e.payload["operation"] != "finalize"));
        let cursor = stream.snapshot().last_seq;
        stream.finish(Some(json!({"status":"completed", "outcome":{"answer_view":view}})), None);
        let (after, terminal) = stream.read_after(Some(cursor), Duration::ZERO);
        assert!(terminal); assert_eq!(after.len(), 2);
        assert_eq!(after[0].payload["operation"], "finalize");
        assert_eq!(after[0].payload["view"], json!(view));
        assert!(stream.snapshot().draft.is_none());
        let failed = RunStream::new(RunDescriptor { book_id:"book".into(), session_id:"session".into(), turn_id:"failed".into() });
        let cursor = failed.snapshot().last_seq;
        failed.finish(None, Some(json!({"error_code":"STORE_ERROR"})));
        let (after, _) = failed.read_after(Some(cursor), Duration::ZERO);
        assert_eq!(after[0].payload["operation"], "discard");
        assert_eq!(after[1].event_type, "run.persistence_failed");
    }
    #[test]
    fn evicted_cursor_gets_atomic_snapshot_then_only_new_events() {
        let stream = RunStream::new(RunDescriptor { book_id: "book".into(), session_id: "session".into(), turn_id: "turn".into() });
        let events = runtime::run_events::RunEvents::new(Some(stream.clone()));
        for i in 0..800 { let activity = events.begin("tool", "book.text", &format!("read {i}"), true); events.finish(activity, runtime::run_events::ActivityStatus::Succeeded, None, None, None); }
        let (frames, _) = stream.read_after(Some(1), Duration::ZERO);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event_type, "run.snapshot");
        assert_eq!(frames[0].payload["activities"], json!(events.activities()));
        let cursor = frames[0].seq;
        events.begin("model", "outer", "生成回答", true);
        let (next, _) = stream.read_after(Some(cursor), Duration::ZERO);
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].seq, cursor + 1);
        assert!(stream.buffer.lock().unwrap().bytes <= EVENT_BYTES);
    }
}
