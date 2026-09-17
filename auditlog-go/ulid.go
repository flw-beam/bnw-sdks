package audit

import (
	"crypto/rand"
	"time"

	"github.com/oklog/ulid/v2"
)

// newULID generates a fresh ULID at now, using crypto/rand entropy — the
// same library (github.com/oklog/ulid/v2) audit-service-api's own
// internal/core/ids package uses, so this SDK's generated IDs are
// guaranteed to be exactly the same 26-character Crockford-base32 shape
// the server's ids.ValidULID accepts, with no need to hand-roll the
// encoding independently (unlike this module's canonical-JSON
// encoder, which is duplicated rather than imported).
func newULID(now time.Time) (string, error) {
	id, err := ulid.New(ulid.Timestamp(now.UTC()), rand.Reader)
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

// isValidULID reports whether s is a syntactically valid 26-character ULID.
func isValidULID(s string) bool {
	_, err := ulid.ParseStrict(s)
	return err == nil
}
