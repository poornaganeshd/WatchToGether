import bcrypt from "bcrypt";

const BCRYPT_PREFIX = /^\$2[aby]\$/;

export const hashRoomPassword = (password: string) => bcrypt.hash(password, 10);

// Rooms created before hashing was introduced store the password in plain text,
// so fall back to a direct comparison for those rows.
export const verifyRoomPassword = async (stored: string | null, candidate: string | undefined): Promise<boolean> => {
  if (!stored) return true;
  if (!candidate) return false;
  if (BCRYPT_PREFIX.test(stored)) {
    return bcrypt.compare(candidate, stored);
  }
  return stored === candidate;
};
