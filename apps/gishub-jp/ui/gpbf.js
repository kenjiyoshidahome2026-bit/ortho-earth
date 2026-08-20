import { createGeopbf } from 'geopbf';
import { nativeBucket } from 'native-bucket';
import { API_BASE } from './config.js';

export const geopbf = createGeopbf(API_BASE, { bucket: nativeBucket });
