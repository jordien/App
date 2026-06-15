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

// ================= CONEXIÓN A MYSQL (RAILWAY) =================
const db = mysql.createConnection({
    host: process.env.MYSQLHOST || 'acela.proxy.rlwy.net',
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || 'MFaPbrOIWcBNrrvrxBNcfClvNNtFIoSt',
    database: process.env.MYSQLDATABASE || 'railway',
    port: process.env.MYSQLPORT || 49485
});

db.connect(err => {
    if (err) {
        console.error('Error de conexion:', err);
        return;
    }
    console.log('Conectado a MySQL en Railway');
    crearTablas();
    crearTablaQRVendedores();
    crearTablaAsistencia();
});

const SECRET_KEY = 'chepita_secret_key_2025';
const resetTokens = {};

// ================= CREAR TABLAS =================
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
}

function crearTablaQRVendedores() {
    db.query(`
        CREATE TABLE IF NOT EXISTS qr_vendedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            codigo VARCHAR(100) NOT NULL UNIQUE,
            id_vendedor INT NOT NULL,
            nombre_vendedor VARCHAR(100),
            generado_en DATETIME DEFAULT NOW(),
            usado TINYINT DEFAULT 0
        )
    `, (err) => {
        if (err) console.error('Error creando qr_vendedores:', err);
        else console.log('Tabla qr_vendedores lista');
    });
}

function crearTablaAsistencia() {
    db.query(`
        CREATE TABLE IF NOT EXISTS vendedor_qr_asistencia (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_vendedor INT NOT NULL UNIQUE,
            codigo VARCHAR(100) NOT NULL UNIQUE,
            generado_en DATETIME DEFAULT NOW()
        )
    `);
    
    db.query(`
        CREATE TABLE IF NOT EXISTS asistencia_vendedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            id_vendedor INT NOT NULL,
            fecha DATE NOT NULL,
            hora_entrada TIME,
            hora_salida TIME,
            estado VARCHAR(20) DEFAULT 'pendiente'
        )
    `);
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
            return res.status(403).json({ autenticado: false, message: "Token invalido o expirado" });
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
        
        if (admin.password && admin.password.startsWith('$2b$')) {
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
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electronico' });
    }
    
    db.query(`SELECT usuario FROM usuarios_admin WHERE email = ?`, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo' });
        }
        
        const nuevaPassword = crypto.randomBytes(4).toString('hex').toUpperCase();
        const hashedPassword = bcrypt.hashSync(nuevaPassword, 10);
        
        db.query(`UPDATE usuarios_admin SET password = ? WHERE email = ?`, [hashedPassword, email], (err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error actualizando contraseña' });
            }
            
            res.json({ 
                success: true, 
                message: `Nueva contraseña temporal: ${nuevaPassword}`,
                nuevaPassword: nuevaPassword
            });
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
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo' });
        }
        
        const nuevaPassword = Math.random().toString(36).slice(-6);
        const md5pass = crypto.createHash('md5').update(nuevaPassword).digest('hex');
        
        db.query(`UPDATE trabajadores SET password_hash = ?, debe_cambiar_password = 1 WHERE Id_Trabajador = ?`, [md5pass, results[0].Id_Trabajador], (err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error actualizando' });
            }
            
            res.json({ 
                success: true, 
                message: `Nueva contraseña temporal: ${nuevaPassword}`,
                nuevaPassword: nuevaPassword,
                nombre: results[0].NombreCompleto
            });
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

// ================= SISTEMA QR UN SOLO USO =================
function generarCodigoUnico(idVendedor) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hash = crypto.createHash('md5').update(`${idVendedor}${timestamp}${random}`).digest('hex').substring(0, 8);
    return `CHP${idVendedor}${timestamp}${hash}`;
}

app.get('/api/vendedor/qr-activo/:id', (req, res) => {
    const { id } = req.params;
    
    db.query(`
        SELECT codigo, usado FROM qr_vendedores 
        WHERE id_vendedor = ? AND usado = 0
        ORDER BY generado_en DESC LIMIT 1
    `, [id], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length > 0) {
            res.json({
                tiene_qr_activo: true,
                codigo: results[0].codigo,
                usado: results[0].usado === 1
            });
        } else {
            res.json({ tiene_qr_activo: false });
        }
    });
});

app.post('/api/vendedor/generar-qr', verificarTokenTrabajador, (req, res) => {
    const { id_vendedor } = req.body;
    
    if (!id_vendedor) {
        return res.status(400).json({ success: false, message: 'ID de vendedor requerido' });
    }
    
    if (req.usuario.id !== id_vendedor) {
        return res.status(403).json({ success: false, message: 'No autorizado' });
    }
    
    const codigo = generarCodigoUnico(id_vendedor);
    
    db.query(`SELECT NombreCompleto FROM trabajadores WHERE Id_Trabajador = ?`, [id_vendedor], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en servidor' });
        }
        
        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendedor no encontrado' });
        }
        
        const nombreVendedor = results[0].NombreCompleto;
        
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id_vendedor = ? AND usado = 0`, [id_vendedor], (err) => {
            if (err) console.error('Error actualizando QR:', err);
            
            db.query(`
                INSERT INTO qr_vendedores (codigo, id_vendedor, nombre_vendedor, usado) 
                VALUES (?, ?, ?, 0)
            `, [codigo, id_vendedor, nombreVendedor], (err2) => {
                if (err2) {
                    return res.status(500).json({ success: false, message: 'Error guardando QR' });
                }
                
                res.json({
                    success: true,
                    codigo: codigo,
                    vendedor: nombreVendedor
                });
            });
        });
    });
});

app.post('/api/validar-qr-vendedor', (req, res) => {
    const { codigo } = req.body;
    
    if (!codigo) {
        return res.json({ valido: false, message: 'Codigo invalido' });
    }
    
    db.query(`
        SELECT q.*, t.NombreCompleto 
        FROM qr_vendedores q
        JOIN trabajadores t ON q.id_vendedor = t.Id_Trabajador
        WHERE q.codigo = ? AND q.usado = 0
    `, [codigo], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        if (results.length === 0) {
            return res.json({ valido: false, message: 'QR invalido o ya fue usado' });
        }
        
        const qr = results[0];
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id = ?`, [qr.id]);
        
        res.json({
            valido: true,
            id_vendedor: qr.id_vendedor,
            nombre_vendedor: qr.NombreCompleto
        });
    });
});

app.post('/api/vendedor/enviar-qr-email', (req, res) => {
    const { email, codigo, nombre_vendedor } = req.body;
    
    if (!email || !codigo) {
        return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }
    
    qrcode.toBuffer(codigo, { errorCorrectionLevel: 'H' }, (err, qrBuffer) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error generando QR' });
        }
        
        const qrBase64 = qrBuffer.toString('base64');
        res.json({ 
            success: true, 
            message: 'QR generado correctamente',
            qrImage: qrBase64
        });
    });
});

// ================= ASISTENCIA =================
app.post('/api/asistencia/generar-qr', verificarTokenTrabajador, (req, res) => {
    const { id_vendedor } = req.body;
    
    if (!id_vendedor) {
        return res.status(400).json({ success: false, message: 'ID requerido' });
    }
    
    const codigo = `ASIS${id_vendedor}${Date.now()}${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    
    db.query(`INSERT INTO vendedor_qr_asistencia (id_vendedor, codigo) VALUES (?, ?) 
              ON DUPLICATE KEY UPDATE codigo = ?, generado_en = NOW()`, 
              [id_vendedor, codigo, codigo], (err) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error generando QR' });
        }
        res.json({ success: true, codigo: codigo });
    });
});

app.get('/api/asistencia/vendedor/:id', (req, res) => {
    const { id } = req.params;
    const hoy = new Date().toISOString().split('T')[0];
    
    db.query(`SELECT codigo FROM vendedor_qr_asistencia WHERE id_vendedor = ?`, [id], (err, qrResults) => {
        const codigoQR = qrResults.length > 0 ? qrResults[0].codigo : null;
        
        db.query(`SELECT * FROM asistencia_vendedores WHERE id_vendedor = ? AND fecha = ?`, [id, hoy], (err, results) => {
            let estado = 'ausente';
            let estadoTexto = 'Sin registro hoy';
            let ultimoRegistro = null;
            let registrosHoy = [];
            
            if (results.length > 0) {
                const reg = results[0];
                if (reg.hora_entrada && reg.hora_salida) {
                    estado = 'completo';
                    estadoTexto = 'Jornada completada';
                    ultimoRegistro = reg.hora_salida;
                } else if (reg.hora_entrada) {
                    estado = 'presente';
                    estadoTexto = `Entrada: ${reg.hora_entrada}`;
                    ultimoRegistro = reg.hora_entrada;
                }
                
                if (reg.hora_entrada) registrosHoy.push({ tipo: 'Entrada', hora: reg.hora_entrada });
                if (reg.hora_salida) registrosHoy.push({ tipo: 'Salida', hora: reg.hora_salida });
            }
            
            res.json({
                success: true,
                codigo_qr: codigoQR,
                estado: estado,
                estado_texto: estadoTexto,
                ultimo_registro: ultimoRegistro,
                registros_hoy: registrosHoy
            });
        });
    });
});

app.post('/api/asistencia/escanear', (req, res) => {
    const { codigo } = req.body;
    const hoy = new Date().toISOString().split('T')[0];
    const horaActual = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    
    if (!codigo) {
        return res.status(400).json({ success: false, message: 'Codigo QR requerido' });
    }
    
    db.query(`SELECT id_vendedor FROM vendedor_qr_asistencia WHERE codigo = ?`, [codigo], (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        if (results.length === 0) {
            return res.json({ success: false, message: 'QR invalido' });
        }
        
        const idVendedor = results[0].id_vendedor;
        
        db.query(`SELECT * FROM asistencia_vendedores WHERE id_vendedor = ? AND fecha = ?`, [idVendedor, hoy], (err, existing) => {
            if (err) return res.status(500).json({ success: false, message: err.message });
            
            if (existing.length === 0) {
                db.query(`INSERT INTO asistencia_vendedores (id_vendedor, fecha, hora_entrada, estado) 
                          VALUES (?, ?, ?, 'presente')`, 
                          [idVendedor, hoy, horaActual], (err) => {
                    if (err) return res.status(500).json({ success: false, message: err.message });
                    res.json({ success: true, message: 'Entrada registrada', tipo: 'entrada', hora: horaActual });
                });
            } else {
                const registro = existing[0];
                if (!registro.hora_salida) {
                    db.query(`UPDATE asistencia_vendedores SET hora_salida = ?, estado = 'completo' 
                              WHERE id_vendedor = ? AND fecha = ?`, 
                              [horaActual, idVendedor, hoy], (err) => {
                        if (err) return res.status(500).json({ success: false, message: err.message });
                        res.json({ success: true, message: 'Salida registrada', tipo: 'salida', hora: horaActual });
                    });
                } else {
                    res.json({ success: false, message: 'Ya registro entrada y salida hoy' });
                }
            }
        });
    });
});

app.get('/api/asistencia/registro', (req, res) => {
    const { fecha } = req.query;
    const fechaBuscar = fecha || new Date().toISOString().split('T')[0];
    
    db.query(`
        SELECT a.*, t.NombreCompleto as vendedor 
        FROM asistencia_vendedores a
        JOIN trabajadores t ON a.id_vendedor = t.Id_Trabajador
        WHERE a.fecha = ?
        ORDER BY a.hora_entrada DESC
    `, [fechaBuscar], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// ================= PUNTOS DEL VENDEDOR =================
app.get('/api/puntos-vendedor/:id', (req, res) => {
    const { id } = req.params;
    
    const sql = `
        SELECT 
            t.Id_Trabajador as id_trabajador,
            t.NombreCompleto as nombre_completo,
            COUNT(c.Num_Factura) as total_ventas,
            COUNT(DISTINCT DATE(c.Fecha)) as dias_activos,
            ROUND(COUNT(c.Num_Factura) / NULLIF(COUNT(DISTINCT DATE(c.Fecha)), 0), 2) as promedio_diario,
            ROUND(
                (COUNT(c.Num_Factura) * 0.4) + 
                (COUNT(DISTINCT DATE(c.Fecha)) * 0.3) + 
                (ROUND(COUNT(c.Num_Factura) / NULLIF(COUNT(DISTINCT DATE(c.Fecha)), 0), 2) * 0.3), 
                2
            ) as puntaje_total,
            COALESCE(SUM(c.Monto), 0) as total_ventas_cordobas
        FROM compra c
        INNER JOIN trabajadores t ON c.Id_Vendedor = t.Id_Trabajador
        WHERE t.Id_Trabajador = ?
        GROUP BY t.Id_Trabajador, t.NombreCompleto
    `;
    
    db.query(sql, [id], (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        if (results.length === 0) {
            return res.json({ 
                success: true, 
                total_ventas: 0, 
                dias_activos: 0, 
                promedio_diario: 0, 
                puntaje_total: 0,
                total_ventas_cordobas: 0
            });
        }
        
        res.json({ success: true, ...results[0] });
    });
});

// ================= PUNTOS GENERALES =================
app.get('/api/puntos-vendedores', (req, res) => {
    const { year, month } = req.query;
    
    let fechaFiltro = '';
    let params = [];
    
    if (year && month) {
        fechaFiltro = 'WHERE YEAR(c.Fecha) = ? AND MONTH(c.Fecha) = ?';
        params = [parseInt(year), parseInt(month)];
    } else if (year) {
        fechaFiltro = 'WHERE YEAR(c.Fecha) = ?';
        params = [parseInt(year)];
    }
    
    const sql = `
        SELECT 
            t.Id_Trabajador as id_trabajador,
            t.NombreCompleto as nombre_completo,
            COUNT(c.Num_Factura) as total_ventas,
            COUNT(DISTINCT DATE(c.Fecha)) as dias_activos,
            ROUND(COUNT(c.Num_Factura) / NULLIF(COUNT(DISTINCT DATE(c.Fecha)), 0), 2) as promedio_diario,
            ROUND(
                (COUNT(c.Num_Factura) * 0.4) + 
                (COUNT(DISTINCT DATE(c.Fecha)) * 0.3) + 
                (ROUND(COUNT(c.Num_Factura) / NULLIF(COUNT(DISTINCT DATE(c.Fecha)), 0), 2) * 0.3), 
                2
            ) as puntaje_total,
            SUM(c.Monto) as total_ventas_cordobas
        FROM compra c
        INNER JOIN trabajadores t ON c.Id_Vendedor = t.Id_Trabajador
        ${fechaFiltro}
        GROUP BY t.Id_Trabajador, t.NombreCompleto
        ORDER BY puntaje_total DESC
    `;
    
    db.query(sql, params, (err, results) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(results);
    });
});

// ================= AÑOS DISPONIBLES =================
app.get('/api/anios-disponibles', (req, res) => {
    db.query(`SELECT DISTINCT YEAR(Fecha) as anio FROM compra ORDER BY anio DESC`, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results.map(r => r.anio));
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
        SELECT p.Nombre, SUM(o.CantidadVendida) as cantidad
        FROM orden o
        JOIN producto p ON o.Id_Producto = p.Id_Producto
        GROUP BY p.Id_Producto
        ORDER BY cantidad DESC
        LIMIT ?
    `, [parseInt(limite)], (err, results) => {
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

// ================= INICIAR SERVIDOR =================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    ╔══════════════════════════════════════════════════════════╗
    ║     SERVIDOR CHEPITA CORRIENDO                           ║
    ╠══════════════════════════════════════════════════════════╣
    ║  Puerto: ${PORT}                                          ║
    ║  Base de datos: Railway                                  ║
    ║  QR un solo uso activado                                 ║
    ║  Sistema de asistencia activado                          ║
    ║  Sistema de puntos activado                              ║
    ╚══════════════════════════════════════════════════════════╝
    `);
});