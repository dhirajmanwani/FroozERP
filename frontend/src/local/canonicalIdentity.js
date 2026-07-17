const clean = (value) => String(value ?? "").trim();
const normalizedRole = (value) => clean(value).toUpperCase();

export const reconcileCanonicalIdentity = ({ authenticatedUser, cloudIdentity, deviceInfo }) => {
  const localUser = authenticatedUser && typeof authenticatedUser === "object" ? authenticatedUser : {};
  const cloud = cloudIdentity && typeof cloudIdentity === "object" ? cloudIdentity : {};
  const localUserId = clean(localUser.id || localUser.user_id);
  const cloudUserId = clean(cloud.user_id || cloud.id);
  const localDeviceId = clean(deviceInfo?.device_id);
  const cloudDeviceId = clean(cloud.device_id);

  if (!localUserId || !cloudUserId || localUserId !== cloudUserId) {
    throw new Error("Authenticated user does not match the canonical cloud user ID.");
  }
  if (!localDeviceId || !cloudDeviceId || localDeviceId !== cloudDeviceId) {
    throw new Error("Authenticated device does not match the canonical cloud device ID.");
  }
  const companyId = clean(cloud.company_id);
  const branchId = clean(cloud.branch_id);
  if (!companyId || !branchId) {
    throw new Error("Canonical cloud company and branch scope are required.");
  }

  const role = clean(cloud.role || localUser.role_name || localUser.role);
  return {
    ...localUser,
    id: Number.isFinite(Number(cloudUserId)) ? Number(cloudUserId) : cloudUserId,
    username: localUser.username,
    role,
    role_name: role,
    normalized_role: normalizedRole(role),
    company_id: Number.isFinite(Number(companyId)) ? Number(companyId) : companyId,
    branch_id: Number.isFinite(Number(branchId)) ? Number(branchId) : branchId,
    canonical_user_id: cloudUserId,
    canonical_device_id: cloudDeviceId,
    device_approval_status: clean(cloud.registration_status || cloud.status).toUpperCase(),
    authentication_source: localUser.authentication_source || "authenticated_froozerp_session",
  };
};

export const findConflictingCloudUsers = (users, { authenticatedUsername, canonicalUserId }) => {
  const username = clean(authenticatedUsername).toLowerCase();
  const canonicalId = clean(canonicalUserId);
  return (Array.isArray(users) ? users : []).filter((user) => (
    clean(user.username).toLowerCase() === username && clean(user.user_id || user.id) !== canonicalId
  ));
};

export const buildCanonicalAliasLoginClaim = ({ deviceInfo, snapshot, username }) => {
  const profile = snapshot?.user_profile && typeof snapshot.user_profile === "object"
    ? snapshot.user_profile
    : {};
  const requestedUsername = clean(username).toLowerCase();
  const profileUsername = clean(profile.username).toLowerCase();
  const canonicalUserId = clean(profile.canonical_user_id || profile.id || profile.user_id);
  const snapshotDeviceId = clean(snapshot?.device_identity?.device_id || deviceInfo?.device_id);
  const deviceId = clean(deviceInfo?.device_id);
  if (!requestedUsername || requestedUsername !== profileUsername || !canonicalUserId || !deviceId || snapshotDeviceId !== deviceId) {
    return {};
  }
  return { canonical_user_id: canonicalUserId };
};
