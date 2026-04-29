import crypto from 'crypto';
import { env } from '../config/env';

const ALGORITHM = 'aes-256-cbc';
const KEY = Buffer.from(env.ENCRYPTION_KEY); // Debe ser de 32 bytes
const IV_LENGTH = 16; // Para AES-256-CBC el IV es de 16 bytes

/**
 * Encripta un string utilizando AES-256-CBC.
 */
export const encrypt = (text: string): string => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  // Retornamos el IV y el texto encriptado concatenados
  return `${iv.toString('hex')}:${encrypted}`;
};

/**
 * Desencripta un string utilizando AES-256-CBC.
 */
export const decrypt = (text: string): string => {
  try {
    const parts = text.split(':');
    if (parts.length !== 2)
      throw new Error('Formato de token encriptado inválido');

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);

    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
  } catch (error: unknown) {
    throw new Error(
      'No se pudo desencriptar el token. La llave es incorrecta o el formato es inválido.',
      { cause: error },
    );
  }
};
