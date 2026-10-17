import { createGeopbf, type BucketProvider } from 'geopbf';
import { nativeBucket } from 'native-bucket';
import { API_BASE } from './config.ts';

export const geopbf = createGeopbf(API_BASE, { bucket: nativeBucket as BucketProvider });
