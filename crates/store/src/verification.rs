use super::{Result, Scope, Store, check_budget, entry_bytes, now};
use board_domain::{
    Id,
    verification::{CardVerification, MAX_VERIFICATIONS, VerificationDraft},
};
use rusqlite::{Connection, OptionalExtension, params};

pub(super) const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS card_verifications (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (board_id, id)
) WITHOUT ROWID, STRICT;
";

// Keep evidence with a deleted card's identity so restoring the card also restores its evidence.
impl Store {
    pub(super) fn verification_bytes(&self, board: Id) -> Result<usize> {
        let bytes = self.db.query_row(
            "SELECT COALESCE(SUM(length(CAST(body AS BLOB))+1), 0) FROM card_verifications WHERE board_id=?1",
            [board.to_string()],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(usize::try_from(bytes)?)
    }

    pub(super) fn write_verification(
        db: &Connection,
        board: Id,
        record: &CardVerification,
    ) -> Result<()> {
        db.execute(
            "INSERT INTO card_verifications VALUES (?1,?2,?3,?4,?5)",
            params![
                board.to_string(),
                record.id.to_string(),
                record.card_id.to_string(),
                i64::try_from(record.recorded_at)?,
                serde_json::to_string(record)?
            ],
        )?;
        Ok(())
    }

    pub fn board_verification(&self, scope: Scope) -> Result<Vec<CardVerification>> {
        self.scoped(scope)?;
        let (records, _) = self.scene_rows(
            "SELECT v.body FROM card_verifications v JOIN nodes n
              ON n.board_id=v.board_id AND n.id=v.card_id
             WHERE v.board_id=?1 ORDER BY v.recorded_at DESC,v.id",
            scope.board_id,
        )?;
        Ok(records)
    }

    fn verification_record(&self, board: Id, id: Id) -> Result<Option<CardVerification>> {
        let body = self
            .db
            .query_row(
                "SELECT body FROM card_verifications WHERE board_id=?1 AND id=?2",
                params![board.to_string(), id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(body.map(|body| serde_json::from_str(&body)).transpose()?)
    }

    pub fn record_verification(
        &mut self,
        scope: Scope,
        card_id: Id,
        id: Id,
        check: VerificationDraft,
    ) -> Result<CardVerification> {
        let active = self.scoped(scope)?;
        if !active.graph.nodes.contains_key(&card_id) {
            return Err("This card no longer exists on the board.".into());
        }
        let record = CardVerification {
            id,
            card_id,
            recorded_at: now(),
            check: check.normalized(),
        };
        record.validate()?;
        if let Some(previous) = self.verification_record(scope.board_id, id)? {
            if previous.card_id == card_id && previous.check == record.check {
                return Ok(previous);
            }
            return Err("This verification ID already belongs to another record.".into());
        }
        let count = self.db.query_row(
            "SELECT count(*) FROM card_verifications WHERE board_id=?1",
            [scope.board_id.to_string()],
            |row| row.get::<_, i64>(0),
        )?;
        if usize::try_from(count)? >= MAX_VERIFICATIONS {
            return Err("This board reached its limit of 1,024 verification records.".into());
        }
        let bytes = entry_bytes(&record)?;
        check_budget(active.semantic_bytes + bytes, active.drawing_bytes)?;
        let tx = self.db.transaction()?;
        Self::write_verification(&tx, scope.board_id, &record)?;
        tx.execute(
            "UPDATE boards SET updated_at=?1 WHERE id=?2",
            params![
                i64::try_from(record.recorded_at)?,
                scope.board_id.to_string()
            ],
        )?;
        tx.commit()?;
        let active = self.active.as_mut().expect("scoped active board");
        active.semantic_bytes += bytes;
        active.board.updated_at = record.recorded_at;
        Ok(record)
    }

    pub fn remove_verification(&mut self, scope: Scope, card: Id, id: Id) -> Result<()> {
        let active = self.scoped(scope)?;
        if !active.graph.nodes.contains_key(&card) {
            return Err("This card no longer exists on the board.".into());
        }
        let Some(record) = self.verification_record(scope.board_id, id)? else {
            return Ok(());
        };
        if record.card_id != card {
            return Err("This verification record does not belong to the selected card.".into());
        }
        let bytes = entry_bytes(&record)?;
        self.db.execute(
            "DELETE FROM card_verifications WHERE board_id=?1 AND id=?2",
            params![scope.board_id.to_string(), id.to_string()],
        )?;
        self.active
            .as_mut()
            .expect("scoped active board")
            .semantic_bytes -= bytes;
        Ok(())
    }

    pub fn verification_reference(&self, scope: Scope, id: Id) -> Result<String> {
        let active = self.scoped(scope)?;
        let record = self
            .verification_record(scope.board_id, id)?
            .filter(|record| active.graph.nodes.contains_key(&record.card_id))
            .ok_or("This verification record no longer exists on the board.")?;
        record.validate()?;
        Ok(record
            .check
            .reference
            .ok_or("This record has no reference.")?)
    }
}
