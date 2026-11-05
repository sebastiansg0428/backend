const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument, EncryptedPDFError } = require('pdf-lib');

function filtroPdf(req, file, cb) {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf' ||
        (file.mimetype && file.mimetype !== 'application/pdf')) {
        return cb(Object.assign(new Error('Cada documento adjunto debe ser un PDF.'), { code: 'PDF_TIPO_INVALIDO' }));
    }
    cb(null, true);
}
const opcionesCargaPdf = { limits: { fileSize: 10 * 1024 * 1024, files: 5 }, fileFilter: filtroPdf };
async function validarArchivoPdf(archivo) {
    const invalido = 'Uno o más archivos no contienen un PDF válido.';
    if (!archivo || archivo.size < 5) return invalido;
    const contenido = await fs.readFile(archivo.path);
    if (!/^%PDF-\d\.\d[\r\n]/.test(contenido.subarray(0, 9).toString('ascii')) ||
        !/%%EOF[\x00\t\n\f\r ]*$/.test(contenido.subarray(-1024).toString('latin1'))) return invalido;
    try {
        const documento = await PDFDocument.load(contenido, { throwOnInvalidObject: true, updateMetadata: false });
        documento.getPages();
        return null;
    } catch (error) {
        console.warn('PDF rechazado durante la validacion de estructura:', error.message);
        if (error instanceof EncryptedPDFError ||
            (error instanceof Error && error.message === new EncryptedPDFError().message)) {
            return 'El archivo PDF está cifrado o protegido con contraseña y no se puede validar. Adjunta una copia sin protección, si tienes autorización para hacerlo.';
        }
        return invalido;
    }
}
module.exports = { filtroPdf, opcionesCargaPdf, validarArchivoPdf };
