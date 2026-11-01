import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import type { AppUser } from './user';
import {
	anyPasskeysExist,
	consumeChallenge,
	getPasskey,
	insertPasskey,
	listPasskeys,
	storeChallenge,
	touchPasskey,
	type PasskeyRow
} from './passkeys';

/**
 * WebAuthn (passkeys) on top of @simplewebauthn/server. The RP id and
 * origin derive from the request URL, so this works unchanged on any
 * deployment domain. Discoverable credentials are required, which makes
 * login usernameless — the authenticator tells us who is signing in.
 */

const RP_NAME = 'Zajel Mail';

function rpId(url: URL): string {
	return url.hostname;
}

/** The challenge a response was signed over, as issued (base64url). */
function challengeFromResponse(response: { clientDataJSON: string }): string | undefined {
	try {
		const clientData = JSON.parse(
			Buffer.from(response.clientDataJSON, 'base64url').toString('utf8')
		) as { challenge?: string };
		return clientData.challenge;
	} catch {
		return undefined;
	}
}

export async function registrationOptions(url: URL, user: AppUser) {
	const existing = listPasskeys(user.id);
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: rpId(url),
		userName: user.email,
		userID: Buffer.from(user.id, 'utf8'),
		attestationType: 'none',
		excludeCredentials: existing.map((p) => ({
			id: p.id,
			transports: p.transports ? JSON.parse(p.transports) : undefined
		})),
		// A passkey is a whole sign-in by itself, so it has to check it's you
		// (fingerprint, face or PIN), not just that a key is present.
		authenticatorSelection: {
			residentKey: 'required',
			userVerification: 'required'
		}
	});
	storeChallenge(options.challenge, user.id, 'reg');
	return options;
}

export async function verifyRegistration(
	url: URL,
	user: AppUser,
	response: RegistrationResponseJSON,
	name: string
): Promise<{ id: string } | undefined> {
	const challenge = challengeFromResponse(response.response);
	if (!challenge) return undefined;
	const issued = consumeChallenge(challenge, 'reg');
	if (!issued || issued.userId !== user.id) return undefined;

	const verification = await verifyRegistrationResponse({
		response,
		expectedChallenge: challenge,
		expectedOrigin: url.origin,
		expectedRPID: rpId(url),
		requireUserVerification: true
	});
	if (!verification.verified || !verification.registrationInfo) return undefined;

	const { credential } = verification.registrationInfo;
	insertPasskey({
		id: credential.id,
		userId: user.id,
		publicKey: Buffer.from(credential.publicKey).toString('base64url'),
		counter: credential.counter,
		transports: credential.transports,
		name
	});
	return { id: credential.id };
}

export async function authenticationOptions(url: URL) {
	if (!anyPasskeysExist()) return undefined;
	const options = await generateAuthenticationOptions({
		rpID: rpId(url),
		userVerification: 'required'
		// allowCredentials omitted: discoverable credentials, usernameless.
	});
	storeChallenge(options.challenge, null, 'auth');
	return options;
}

export async function verifyAuthentication(
	url: URL,
	response: AuthenticationResponseJSON
): Promise<PasskeyRow | undefined> {
	const passkey = getPasskey(response.id);
	if (!passkey) return undefined;

	const challenge = challengeFromResponse(response.response);
	if (!challenge) return undefined;
	if (!consumeChallenge(challenge, 'auth')) return undefined;

	const verification = await verifyAuthenticationResponse({
		response,
		expectedChallenge: challenge,
		expectedOrigin: url.origin,
		expectedRPID: rpId(url),
		requireUserVerification: true,
		credential: {
			id: passkey.id,
			publicKey: Buffer.from(passkey.public_key, 'base64url'),
			counter: passkey.counter,
			transports: passkey.transports ? JSON.parse(passkey.transports) : undefined
		}
	});
	if (!verification.verified) return undefined;

	touchPasskey(passkey.id, verification.authenticationInfo.newCounter);
	return passkey;
}
