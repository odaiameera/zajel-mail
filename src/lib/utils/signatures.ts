import { get } from 'svelte/store';
import { userState, type SignatureValue } from '$lib/stores/userState';

/**
 * Pick the signature to use for a given identity. Cascade:
 *   1. Per-identity override (identity_signatures table)
 *   2. Global default (signatures.is_default = 1)
 *   3. First signature in the list
 *   4. null if there are no signatures at all
 *
 * Pass `null` for identityId when the composer doesn't know the from
 * identity yet (e.g. cache hasn't loaded) — the cascade still resolves
 * to the global default if one exists.
 */
export function resolveSignatureForIdentity(identityId: string | null): number | null {
	const { signatures, identitySignatures } = get(userState);
	if (signatures.length === 0) return null;

	if (identityId) {
		const overrideId = identitySignatures.get(identityId);
		if (overrideId !== undefined && signatures.some((s) => s.id === overrideId)) {
			return overrideId;
		}
	}

	const def = signatures.find((s) => s.isDefault);
	return (def ?? signatures[0]).id;
}

export function getSignatureById(id: number | null): SignatureValue | null {
	if (id === null) return null;
	const { signatures } = get(userState);
	return signatures.find((s) => s.id === id) ?? null;
}
