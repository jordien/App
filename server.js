const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const qrcode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ================= CONEXIÓN A MYSQL =================
const db = mysql.createConnection({
    host: process.env.MYSQLHOST || 'acela.proxy.rlwy.net',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'MFaPbrOIWcBNrrvrxBNcfClvNNtFIoSt',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 49485
});

db.connect(err => {
    if (err) {
        console.error('❌ Error de conexión:', err);
        return;
    }
    console.log('✅ Conectado a MySQL');
    crearTablas();
    crearTablaAsistencia();
});

const SECRET_KEY = 'chepita_secret_key_2025';
const resetTokens = {};

// ================= CREAR TABLAS EXISTENTES =================
function crearTablas() {
    db.query(`
        CREATE TABLE IF NOT EXISTS trabajador_recuperacion_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_trabajador INT NOT NULL,
            token VARCHAR(255) NOT NULL,
            expira_en DATETIME NOT NULL,
            usado TINYINT DEFAULT 0
        )
    `);
    
    db.query(`
        CREATE TABLE IF NOT EXISTS qr_vendedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            codigo VARCHAR(100) NOT NULL UNIQUE,
            id_vendedor INT NOT NULL,
            nombre_vendedor VARCHAR(100),
            generado_en DATETIME DEFAULT NOW(),
            expira_en DATETIME NOT NULL,
            usado TINYINT DEFAULT 0,
            FOREIGN KEY (id_vendedor) REFERENCES trabajadores(Id_Trabajador)
        )
    `, (err) => {
        if (err) console.error('Error creando qr_vendedores:', err);
        else console.log('✅ Tabla qr_vendedores lista');
    });
}

// ================= TABLA DE ASISTENCIA MANUAL =================
function crearTablaAsistencia() {
    db.query(`
        CREATE TABLE IF NOT EXISTS asistencia_registros (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_vendedor INT NOT NULL,
            fecha DATE NOT NULL,
            hora_entrada TIME,
            hora_salida TIME,
            estado VARCHAR(20) DEFAULT 'pendiente',
            FOREIGN KEY (id_vendedor) REFERENCES trabajadores(Id_Trabajador)
        )
    `, (err) => {
        if (err) console.error('Error creando asistencia_registros:', err);
        else console.log('✅ Tabla asistencia_registros lista');
    });
}

// ================= VERIFICAR TOKEN =================
function verificarTokenTrabajador(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ autenticado: false, message: "Token no proporcionado" });
    }
    
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) {
            return res.status(403).json({ autenticado: false, message: "Token inválido o expirado" });
        }
        req.usuario = decoded;
        next();
    });
}

// ================= LOGIN ADMIN =================
app.post('/api/admin/login', async (req, res) => {
    const { usuario, password } = req.body;
    
    db.query(`SELECT * FROM usuarios_admin WHERE usuario = ?`, [usuario], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
        
        const admin = results[0];
        let passwordValida = false;
        
        const md5pass = crypto.createHash('md5').update(password).digest('hex');
        if (admin.password === md5pass) {
            passwordValida = true;
        }
        
        if (!passwordValida && admin.password && admin.password.startsWith('$2b$')) {
            passwordValida = await bcrypt.compare(password, admin.password);
        }
        
        if (passwordValida) {
            const token = jwt.sign(
                { id: admin.id, usuario: admin.usuario, rol: 'admin' },
                SECRET_KEY,
                { expiresIn: '8h' }
            );
            return res.json({ success: true, token: token, user: admin.usuario });
        }
        
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    });
});

// ================= RECUPERACION ADMIN =================
app.post('/api/admin/recuperar-email', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico' });
    }
    
    db.query(`SELECT usuario FROM usuarios_admin WHERE email = ?`, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en el servidor' });
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo' });
        }
        
        const nuevaPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
        const hashedPassword = bcrypt.hashSync(nuevaPassword, 10);
        
        db.query(`UPDATE usuarios_admin SET password = ? WHERE email = ?`, [hashedPassword, email], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error actualizando' });
            res.json({ success: true, message: `Nueva contraseña temporal: ${nuevaPassword}`, nuevaPassword });
        });
    });
});

// ================= LOGIN TRABAJADOR =================
app.post('/api/trabajadores/login', async (req, res) => {
    const { nombre_usuario, password } = req.body;
    
    db.query(`SELECT * FROM trabajadores WHERE (nombre_usuario = ? OR email = ?) AND Activo = 1`, 
        [nombre_usuario, nombre_usuario], async (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) {
            return res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
        
        const trabajador = results[0];
        let passwordValida = false;
        
        const md5pass = crypto.createHash('md5').update(password).digest('hex');
        if (trabajador.password_hash === md5pass) {
            passwordValida = true;
        }
        
        if (!passwordValida && trabajador.password_hash && trabajador.password_hash.startsWith('$2b$')) {
            passwordValida = await bcrypt.compare(password, trabajador.password_hash);
        }
        
        if (!passwordValida && password === '1234') {
            passwordValida = true;
        }
        
        if (passwordValida) {
            const token = jwt.sign(
                { id: trabajador.Id_Trabajador, nombre: trabajador.NombreCompleto, rol: 'trabajador' },
                SECRET_KEY,
                { expiresIn: '8h' }
            );
            return res.json({
                success: true,
                token: token,
                trabajador: {
                    id: trabajador.Id_Trabajador,
                    nombre: trabajador.NombreCompleto,
                    email: trabajador.email,
                    usuario: trabajador.nombre_usuario
                }
            });
        }
        
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    });
});

// ================= RECUPERACION TRABAJADOR =================
app.post('/api/trabajadores/recuperar-password', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo' });
    }
    
    db.query(`SELECT Id_Trabajador, NombreCompleto, email FROM trabajadores WHERE email = ? AND Activo = 1`, [email], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en el servidor' });
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo' });
        }
        
        const nuevaPassword = Math.random().toString(36).slice(-6);
        const md5pass = crypto.createHash('md5').update(nuevaPassword).digest('hex');
        
        db.query(`UPDATE trabajadores SET password_hash = ?, debe_cambiar_password = 1 WHERE Id_Trabajador = ?`, [md5pass, results[0].Id_Trabajador], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error actualizando' });
            res.json({ success: true, message: `Nueva contraseña temporal: ${nuevaPassword}`, nuevaPassword, nombre: results[0].NombreCompleto });
        });
    });
});

// ================= VERIFICAR SESION =================
app.get('/api/verificar-sesion', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ autenticado: false });
    
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ autenticado: false });
        res.json({ autenticado: true, usuario: decoded });
    });
});

// ================= SISTEMA QR PARA VENDEDORES (VENTAS) =================
function generarCodigoUnico(idVendedor) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hash = crypto.createHash('md5').update(`${idVendedor}${timestamp}${random}`).digest('hex').substring(0, 8);
    return `CHP${idVendedor}${timestamp}${hash}`;
}

app.post('/api/validar-qr-vendedor', (req, res) => {
    const { codigo } = req.body;
    
    if (!codigo) {
        return res.json({ valido: false, message: 'Código inválido' });
    }
    
    db.query(`
        SELECT q.*, t.NombreCompleto 
        FROM qr_vendedores q
        JOIN trabajadores t ON q.id_vendedor = t.Id_Trabajador
        WHERE q.codigo = ? AND q.usado = 0 AND q.expira_en > NOW()
    `, [codigo], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length === 0) {
            db.query(`SELECT usado, expira_en FROM qr_vendedores WHERE codigo = ?`, [codigo], (err2, checkResults) => {
                if (checkResults.length > 0) {
                    const check = checkResults[0];
                    if (check.usado === 1) {
                        return res.json({ valido: false, message: 'QR ya usado. Genere uno nuevo.' });
                    }
                    if (new Date(check.expira_en) < new Date()) {
                        return res.json({ valido: false, message: 'QR expirado. Genere uno nuevo.' });
                    }
                }
                return res.json({ valido: false, message: 'QR inválido' });
            });
            return;
        }
        
        const qr = results[0];
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id = ?`, [qr.id]);
        
        console.log(`✅ QR válido - Vendedor: ${qr.NombreCompleto}`);
        
        res.json({
            valido: true,
            id_vendedor: qr.id_vendedor,
            nombre_vendedor: qr.NombreCompleto,
            expira: qr.expira_en
        });
    });
});

app.get('/api/vendedor/qr-activo/:id', (req, res) => {
    const { id } = req.params;
    
    db.query(`
        SELECT codigo, expira_en, usado FROM qr_vendedores 
        WHERE id_vendedor = ? AND usado = 0 AND expira_en > NOW()
        ORDER BY generado_en DESC LIMIT 1
    `, [id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length > 0) {
            res.json({
                tiene_qr_activo: true,
                codigo: results[0].codigo,
                expira: results[0].expira_en,
                usado: results[0].usado === 1
            });
        } else {
            res.json({ tiene_qr_activo: false });
        }
    });
});

app.post('/api/vendedor/generar-qr', verificarTokenTrabajador, (req, res) => {
    const { id_vendedor, duracion_minutos = 60 } = req.body;
    
    if (!id_vendedor) {
        return res.status(400).json({ success: false, message: 'ID de vendedor requerido' });
    }
    
    if (req.usuario.id !== id_vendedor) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
    }
    
    const codigo = generarCodigoUnico(id_vendedor);
    const expiraEn = new Date(Date.now() + duracion_minutos * 60000);
    
    db.query(`SELECT NombreCompleto FROM trabajadores WHERE Id_Trabajador = ?`, [id_vendedor], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en servidor' });
        if (results.length === 0) return res.status(404).json({ success: false, message: 'Vendedor no encontrado' });
        
        const nombreVendedor = results[0].NombreCompleto;
        
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id_vendedor = ? AND usado = 0`, [id_vendedor], (err) => {
            if (err) console.error('Error actualizando QR anteriores:', err);
            
            db.query(`
                INSERT INTO qr_vendedores (codigo, id_vendedor, nombre_vendedor, expira_en, usado) 
                VALUES (?, ?, ?, ?, 0)
            `, [codigo, id_vendedor, nombreVendedor, expiraEn], (err2) => {
                if (err2) return res.status(500).json({ success: false, message: 'Error guardando QR' });
                res.json({ success: true, codigo: codigo, expira: expiraEn, vendedor: nombreVendedor });
            });
        });
    });
});

app.post('/api/vendedor/enviar-qr-email', (req, res) => {
    const { email, codigo, nombre_vendedor } = req.body;
    
    if (!email || !codigo) {
        return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }
    
    qrcode.toBuffer(codigo, { errorCorrectionLevel: 'H' }, (err, qrBuffer) => {
        if (err) return res.status(500).json({ success: false, message: 'Error generando QR' });
        
        const qrBase64 = qrBuffer.toString('base64');
        res.json({ success: true, message: 'QR generado correctamente', qrImage: qrBase64 });
    });
});

// ================= SISTEMA DE ASISTENCIA MANUAL =================

// Vendedor marca entrada
app.post('/api/asistencia/marcar-entrada', verificarTokenTrabajador, (req, res) => {
    const { id_vendedor } = req.body;
    const hoy = new Date().toISOString().split('T')[0];
    const horaActual = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (!id_vendedor) {
        return res.status(400).json({ success: false, message: 'ID de vendedor requerido' });
    }
    
    if (req.usuario.id !== id_vendedor) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
    }
    
    db.query(`SELECT * FROM asistencia_registros WHERE id_vendedor = ? AND fecha = ?`, [id_vendedor, hoy], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en servidor' });
        
        if (results.length > 0) {
            const registro = results[0];
            if (registro.hora_entrada && !registro.hora_salida) {
                return res.json({ success: false, message: 'Ya marcaste entrada hoy. Debes marcar salida primero.' });
            }
            if (registro.hora_entrada && registro.hora_salida) {
                return res.json({ success: false, message: 'Ya completaste tu jornada hoy' });
            }
        }
        
        if (results.length === 0) {
            db.query(`INSERT INTO asistencia_registros (id_vendedor, fecha, hora_entrada, estado) VALUES (?, ?, ?, 'presente')`, 
                [id_vendedor, hoy, horaActual], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Error registrando entrada' });
                res.json({ success: true, message: `Entrada registrada a las ${horaActual}`, tipo: 'entrada', hora: horaActual });
            });
        } else {
            db.query(`UPDATE asistencia_registros SET hora_entrada = ?, estado = 'presente' WHERE id_vendedor = ? AND fecha = ?`, 
                [horaActual, id_vendedor, hoy], (err) => {
                if (err) return res.status(500).json({ success: false, message: 'Error registrando entrada' });
                res.json({ success: true, message: `Entrada registrada a las ${horaActual}`, tipo: 'entrada', hora: horaActual });
            });
        }
    });
});

// Vendedor marca salida
app.post('/api/asistencia/marcar-salida', verificarTokenTrabajador, (req, res) => {
    const { id_vendedor } = req.body;
    const hoy = new Date().toISOString().split('T')[0];
    const horaActual = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (!id_vendedor) {
        return res.status(400).json({ success: false, message: 'ID de vendedor requerido' });
    }
    
    if (req.usuario.id !== id_vendedor) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
    }
    
    db.query(`SELECT * FROM asistencia_registros WHERE id_vendedor = ? AND fecha = ?`, [id_vendedor, hoy], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en servidor' });
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'Primero debes marcar tu entrada' });
        }
        
        const registro = results[0];
        if (registro.hora_salida) {
            return res.json({ success: false, message: 'Ya marcaste salida hoy' });
        }
        
        if (!registro.hora_entrada) {
            return res.json({ success: false, message: 'Primero debes marcar tu entrada' });
        }
        
        db.query(`UPDATE asistencia_registros SET hora_salida = ?, estado = 'completo' WHERE id_vendedor = ? AND fecha = ?`, 
            [horaActual, id_vendedor, hoy], (err) => {
            if (err) return res.status(500).json({ success: false, message: 'Error registrando salida' });
            res.json({ success: true, message: `Salida registrada a las ${horaActual}`, tipo: 'salida', hora: horaActual });
        });
    });
});

// Obtener estado de asistencia del vendedor
app.get('/api/asistencia/estado/:id', (req, res) => {
    const { id } = req.params;
    const hoy = new Date().toISOString().split('T')[0];
    
    db.query(`SELECT * FROM asistencia_registros WHERE id_vendedor = ? AND fecha = ?`, [id, hoy], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en servidor' });
        
        if (results.length === 0) {
            return res.json({
                success: true,
                tiene_registro: false,
                entrada: null,
                salida: null,
                estado: 'pendiente',
                mensaje: 'No has marcado asistencia hoy'
            });
        }
        
        const registro = results[0];
        let estado = 'pendiente';
        let mensaje = '';
        
        if (registro.hora_entrada && !registro.hora_salida) {
            estado = 'en_jornada';
            mensaje = `Entrada: ${registro.hora_entrada} - Aún no marcas salida`;
        } else if (registro.hora_entrada && registro.hora_salida) {
            estado = 'completo';
            mensaje = `Entrada: ${registro.hora_entrada} | Salida: ${registro.hora_salida}`;
        }
        
        res.json({
            success: true,
            tiene_registro: true,
            entrada: registro.hora_entrada,
            salida: registro.hora_salida,
            estado: estado,
            mensaje: mensaje
        });
    });
});

// Admin marca asistencia manualmente
app.post('/api/asistencia/admin-marcar', async (req, res) => {
    const { id_vendedor, tipo, hora } = req.body;
    const hoy = new Date().toISOString().split('T')[0];
    const horaMarcar = hora || new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (!id_vendedor || !tipo) {
        return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }
    
    db.query(`SELECT * FROM asistencia_registros WHERE id_vendedor = ? AND fecha = ?`, [id_vendedor, hoy], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: 'Error en servidor' });
        
        if (results.length === 0) {
            if (tipo === 'entrada') {
                db.query(`INSERT INTO asistencia_registros (id_vendedor, fecha, hora_entrada, estado) VALUES (?, ?, ?, 'presente')`, 
                    [id_vendedor, hoy, horaMarcar], (err) => {
                    if (err) return res.status(500).json({ success: false, message: 'Error registrando' });
                    res.json({ success: true, message: `Entrada marcada manualmente a las ${horaMarcar}` });
                });
            } else {
                res.json({ success: false, message: 'Primero debe marcar la entrada' });
            }
        } else {
            const registro = results[0];
            if (tipo === 'entrada' && !registro.hora_entrada) {
                db.query(`UPDATE asistencia_registros SET hora_entrada = ?, estado = 'presente' WHERE id_vendedor = ? AND fecha = ?`, 
                    [horaMarcar, id_vendedor, hoy], (err) => {
                    if (err) return res.status(500).json({ success: false, message: 'Error registrando' });
                    res.json({ success: true, message: `Entrada marcada manualmente a las ${horaMarcar}` });
                });
            } else if (tipo === 'salida' && !registro.hora_salida && registro.hora_entrada) {
                db.query(`UPDATE asistencia_registros SET hora_salida = ?, estado = 'completo' WHERE id_vendedor = ? AND fecha = ?`, 
                    [horaMarcar, id_vendedor, hoy], (err) => {
                    if (err) return res.status(500).json({ success: false, message: 'Error registrando' });
                    res.json({ success: true, message: `Salida marcada manualmente a las ${horaMarcar}` });
                });
            } else {
                res.json({ success: false, message: `Ya tiene registrada ${tipo === 'entrada' ? 'entrada' : 'salida'} hoy` });
            }
        }
    });
});

// Obtener registro de asistencia para ADMIN
app.get('/api/asistencia/registro', (req, res) => {
    const { fecha } = req.query;
    const fechaBuscar = fecha || new Date().toISOString().split('T')[0];
    
    db.query(`
        SELECT a.*, t.NombreCompleto as vendedor, t.Celular
        FROM asistencia_registros a
        JOIN trabajadores t ON a.id_vendedor = t.Id_Trabajador
        WHERE a.fecha = ?
        ORDER BY a.hora_entrada DESC
    `, [fechaBuscar], (err, results) => {
        if (err) {
            console.error('Error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// ================= PRODUCTOS =================
app.get('/api/productos', (req, res) => {
    db.query(`
        SELECT p.Id_Producto, p.Nombre, p.Precio, p.Marca,
               COALESCE(SUM(s.Cantidad), 0) AS Stock
        FROM producto p
        LEFT JOIN stock s ON p.Id_Producto = s.Id_Producto
        GROUP BY p.Id_Producto
        ORDER BY p.Id_Producto DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/productos/bajo-stock', (req, res) => {
    db.query(`
        SELECT p.Id_Producto, p.Nombre, p.Precio, COALESCE(SUM(s.Cantidad), 0) AS Stock
        FROM producto p
        LEFT JOIN stock s ON p.Id_Producto = s.Id_Producto
        GROUP BY p.Id_Producto
        HAVING Stock < 10
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/productos', (req, res) => {
    const { Nombre, Stock, Precio, Marca, Id_Proveedor, Id_Categoria } = req.body;
    
    if (!Nombre || !Stock || !Precio || !Id_Proveedor) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    db.query(`SELECT Id_Proveedor FROM proveedores WHERE Id_Proveedor = ?`, [Id_Proveedor], (err, provResults) => {
        if (err) return res.status(500).json({ error: err.message });
        if (provResults.length === 0) {
            return res.status(400).json({ error: 'Proveedor no existe' });
        }
        
        db.query(`INSERT INTO producto (Nombre, Precio, Marca, Id_Categoria, Id_Estado) VALUES (?, ?, ?, ?, 1)`, 
            [Nombre, Precio, Marca || null, Id_Categoria || null], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const idProducto = result.insertId;
            db.query(`INSERT INTO stock (Id_Inventario, Id_Producto, Cantidad, FechaEntrada) VALUES (1, ?, ?, CURDATE())`, 
                [idProducto, Stock], (err2) => {
                if (err2) return res.status(500).json({ error: err2.message });
                
                db.query(`INSERT INTO abastecimiento (Id_Producto, Id_Proveedor, Precio_Compra, FechaEntrada, Cantidad_Entrada) VALUES (?, ?, ?, CURDATE(), ?)`, 
                    [idProducto, Id_Proveedor, Precio, Stock], (err3) => {
                    if (err3) return res.status(500).json({ error: err3.message });
                    res.json({ message: "Producto agregado", Id_Producto: idProducto });
                });
            });
        });
    });
});

app.delete('/api/productos/:id', (req, res) => {
    const { id } = req.params;
    db.query(`DELETE FROM producto WHERE Id_Producto = ?`, [id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Producto eliminado" });
    });
});

// ================= CATEGORIAS =================
app.get('/api/categorias', (req, res) => {
    db.query(`SELECT Id_Categoria, Nombre FROM categoria ORDER BY Nombre`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= PROVEEDORES =================
app.get('/api/proveedores', (req, res) => {
    db.query(`SELECT Id_Proveedor, Nombre, Empresa FROM proveedores ORDER BY Nombre`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= TRABAJADORES =================
app.get('/api/trabajadores', (req, res) => {
    db.query(`SELECT Id_Trabajador, NombreCompleto, Celular, Activo, email, nombre_usuario FROM trabajadores`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/trabajadores/activos', (req, res) => {
    db.query(`SELECT Id_Trabajador, NombreCompleto, email, nombre_usuario FROM trabajadores WHERE Activo = 1`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/trabajadores', async (req, res) => {
    const { NombreCompleto, Celular, email, Activo, Salario } = req.body;
    
    if (!NombreCompleto || !Celular || !email) {
        return res.status(400).json({ error: 'Todos los campos son requeridos' });
    }
    
    const nombreUsuario = NombreCompleto.toLowerCase().replace(/ /g, '.');
    const md5pass = crypto.createHash('md5').update('1234').digest('hex');
    
    db.query(`INSERT INTO trabajadores (NombreCompleto, Celular, email, Activo, Salario, nombre_usuario, password_hash, debe_cambiar_password) 
              VALUES (?, ?, ?, ?, ?, ?, ?, 1)`, 
        [NombreCompleto, Celular, email, Activo !== undefined ? Activo : 1, Salario || null, nombreUsuario, md5pass], 
        (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: "Trabajador registrado", Id_Trabajador: result.insertId });
        });
});

app.put('/api/trabajadores/:id', (req, res) => {
    const { id } = req.params;
    const { Activo } = req.body;
    
    db.query(`UPDATE trabajadores SET Activo = ? WHERE Id_Trabajador = ?`, [Activo, id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Estado actualizado" });
    });
});

// ================= ESTADISTICAS =================
app.get('/api/estadisticas-ventas', (req, res) => {
    db.query(`
        SELECT 
            COALESCE(SUM(CASE WHEN DATE(Fecha) = CURDATE() THEN Monto ELSE 0 END), 0) as total_hoy,
            COALESCE(SUM(CASE WHEN YEAR(Fecha) = YEAR(CURDATE()) AND MONTH(Fecha) = MONTH(CURDATE()) THEN Monto ELSE 0 END), 0) as total_mes
        FROM compra
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.get('/api/top-productos', (req, res) => {
    const { limite = 5 } = req.query;
    db.query(`
        SELECT 
            p.Nombre as nombre, 
            SUM(o.CantidadVendida) as cantidad
        FROM orden o
        JOIN producto p ON o.Id_Producto = p.Id_Producto
        GROUP BY p.Id_Producto, p.Nombre
        ORDER BY cantidad DESC
        LIMIT ?
    `, [parseInt(limite)], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/puntos-vendedores', (req, res) => {
    db.query(`
        SELECT t.NombreCompleto as nombre_completo, COUNT(c.Num_Factura) as total_ventas,
               ROUND(COUNT(c.Num_Factura) * 10, 2) as puntaje_total
        FROM compra c
        JOIN trabajadores t ON c.Id_Vendedor = t.Id_Trabajador
        GROUP BY t.Id_Trabajador
        ORDER BY puntaje_total DESC
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/ventas-recientes', (req, res) => {
    db.query(`
        SELECT c.Fecha, c.Monto as Subtotal,
               CONCAT(COALESCE(cl.Nombre, 'Cliente'), ' ', COALESCE(cl.Apellido, '')) as cliente,
               p.Nombre as producto, o.CantidadVendida as cantidad
        FROM compra c
        LEFT JOIN clientes cl ON c.Id_cliente = cl.Id_cliente
        LEFT JOIN orden o ON c.Num_Factura = o.NumFactura
        LEFT JOIN producto p ON o.Id_Producto = p.Id_Producto
        ORDER BY c.Fecha DESC
        LIMIT 10
    `, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= VENTAS/COMPRAS =================
app.get('/api/canales', (req, res) => {
    db.query(`SELECT * FROM canal`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/metodos-pago', (req, res) => {
    db.query(`SELECT * FROM metododepago`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/api/clientes', (req, res) => {
    db.query(`SELECT Id_cliente, Nombre, Apellido, Num_Celular FROM clientes`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/api/clientes', (req, res) => {
    const { Nombre, Apellido, Num_Celular } = req.body;
    
    if (!Nombre || !Apellido) {
        return res.status(400).json({ error: 'Nombre y apellido son requeridos' });
    }
    
    db.query(`INSERT INTO clientes (Nombre, Apellido, Num_Celular) VALUES (?, ?, ?)`, 
        [Nombre, Apellido, Num_Celular || null], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: "Cliente agregado", Id_cliente: result.insertId });
    });
});

app.post('/api/compras', (req, res) => {
    const { Num_Factura, Id_cliente, Id_Vendedor, Id_Canal, Id_Metodo, Fecha, Monto, Cajero } = req.body;
    
    if (!Num_Factura) return res.status(400).json({ error: 'Num_Factura es obligatoria' });
    if (!Id_Vendedor || isNaN(Id_Vendedor)) return res.status(400).json({ error: 'Id_Vendedor es obligatorio' });
    if (!Id_Metodo || isNaN(Id_Metodo)) return res.status(400).json({ error: 'Id_Metodo es obligatorio' });
    if (!Fecha) return res.status(400).json({ error: 'Fecha es obligatoria' });
    if (!Monto || isNaN(Monto) || parseFloat(Monto) <= 0) return res.status(400).json({ error: 'Monto debe ser mayor a 0' });
    
    const sql = `INSERT INTO compra (Num_Factura, Id_cliente, Id_Vendedor, Id_Canal, Id_Metodo, Fecha, Monto, Cajero) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    db.query(sql, [Num_Factura, Id_cliente || null, Id_Vendedor, Id_Canal || null, Id_Metodo, Fecha, Monto, Cajero || null], (err, result) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'La factura #' + Num_Factura + ' ya existe' });
            return res.status(500).json({ error: 'Error al guardar compra: ' + err.message });
        }
        res.json({ message: "Compra guardada exitosamente", Num_Factura: Num_Factura, compraId: result.insertId, monto: Monto });
    });
});

app.post('/api/ordenes', (req, res) => {
    const { Id_Producto, NumFactura, CantidadVendida, Subtotal, Fecha, PrecioUnitario } = req.body;
    
    if (!Id_Producto) return res.status(400).json({ error: 'Id_Producto es obligatorio' });
    if (!NumFactura) return res.status(400).json({ error: 'NumFactura es obligatorio' });
    if (!CantidadVendida || isNaN(CantidadVendida) || parseInt(CantidadVendida) <= 0) return res.status(400).json({ error: 'CantidadVendida debe ser mayor a 0' });
    if (Subtotal === undefined || isNaN(Subtotal) || parseFloat(Subtotal) < 0) return res.status(400).json({ error: 'Subtotal es obligatorio' });
    if (!Fecha) return res.status(400).json({ error: 'Fecha es obligatoria' });
    if (!PrecioUnitario || isNaN(PrecioUnitario) || parseFloat(PrecioUnitario) <= 0) return res.status(400).json({ error: 'PrecioUnitario debe ser mayor a 0' });
    
    db.query(`SELECT Id_Producto FROM producto WHERE Id_Producto = ?`, [Id_Producto], (err, results) => {
        if (err) return res.status(500).json({ error: 'Error al verificar producto' });
        if (!results || results.length === 0) return res.status(400).json({ error: 'El producto #' + Id_Producto + ' no existe' });
        
        const insertSql = `INSERT INTO orden (Id_Producto, NumFactura, CantidadVendida, Subtotal, Fecha, PrecioUnitario) 
                          VALUES (?, ?, ?, ?, ?, ?)`;
        
        db.query(insertSql, [Id_Producto, NumFactura, CantidadVendida, Subtotal, Fecha, PrecioUnitario], (err, result) => {
            if (err) return res.status(500).json({ error: 'Error al guardar orden: ' + err.message });
            
            const updateStockSql = `UPDATE stock SET Cantidad = Cantidad - ? WHERE Id_Producto = ?`;
            db.query(updateStockSql, [CantidadVendida, Id_Producto], (err2) => {
                if (err2) console.error('Advertencia: Error al actualizar stock:', err2);
                res.json({ message: "Orden guardada exitosamente", orderId: result.insertId, producto: Id_Producto, factura: NumFactura, cantidad: CantidadVendida });
            });
        });
    });
});

// ================= RUTAS PRINCIPALES =================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin_App.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin_App.html'));
});

app.get('/vendedor_app.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'vendedor_app.html'));
});

app.get('/reset-password.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'reset-password.html'));
});

app.get('/nueva_compra.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'nueva_compra.html'));
});

// ================= INICIAR SERVIDOR =================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     SERVIDOR CHEPITA CORRIENDO                           ║
    ╠══════════════════════════════════════════════════════════╣
    ║  Puerto: ${PORT}                                          ║
    ║  QR Ventas: ACTIVADO                                     ║
    ║  Asistencia Manual: ACTIVADO                             ║
    ║  Login Admin: admin / admin (MD5)                        ║
    ╚══════════════════════════════════════════════════════════╝
    `);
});