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

// Conexión a MySQL (Railway)
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
    console.log('✅ Conectado a MySQL en Railway');
    crearTablas();
});

function crearTablas() {
    db.query(`
        CREATE TABLE IF NOT EXISTS qr_vendedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            codigo VARCHAR(100) NOT NULL UNIQUE,
            id_vendedor INT NOT NULL,
            nombre_vendedor VARCHAR(100),
            generado_en DATETIME DEFAULT NOW(),
            expira_en DATETIME NOT NULL,
            usado TINYINT DEFAULT 0
        )
    `);
}

const SECRET_KEY = 'chepita_secret_key_2025';
const resetTokens = {};

function generarCodigoUnico(idVendedor) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hash = crypto.createHash('md5').update(`${idVendedor}${timestamp}${random}`).digest('hex').substring(0, 8);
    return `CHP${idVendedor}${timestamp}${hash}`;
}

// ================= VERIFICAR TOKEN TRABAJADOR =================
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

// ================= RECUPERACIÓN ADMIN =================
app.post('/api/admin/recuperar-email', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico' });
    }
    
    db.query(`SELECT usuario FROM usuarios_admin WHERE email = ?`, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta con ese correo electrónico' });
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

// ================= LOGIN TRABAJADOR (CORREGIDO) =================
app.post('/api/trabajadores/login', async (req, res) => {
    const { nombre_usuario, password } = req.body;
    
    console.log('🔐 Intento de login:', { nombre_usuario, password });
    
    // Buscar por nombre_usuario o email
    db.query(`SELECT * FROM trabajadores WHERE (nombre_usuario = ? OR email = ?) AND Activo = 1`, 
        [nombre_usuario, nombre_usuario], async (err, results) => {
        if (err) {
            console.error('Error DB:', err);
            return res.status(500).json({ error: err.message });
        }
        
        if (results.length === 0) {
            console.log('❌ Usuario no encontrado:', nombre_usuario);
            return res.status(401).json({ success: false, message: "Usuario o contraseña incorrectos" });
        }
        
        const trabajador = results[0];
        console.log('👤 Trabajador encontrado:', trabajador.NombreCompleto);
        console.log('🔑 Hash guardado:', trabajador.password_hash);
        
        let passwordValida = false;
        
        // Probar MD5
        const md5pass = crypto.createHash('md5').update(password).digest('hex');
        console.log('🔐 MD5 calculado:', md5pass);
        
        if (trabajador.password_hash === md5pass) {
            passwordValida = true;
            console.log('✅ Login exitoso con MD5');
        }
        
        // Probar bcrypt si no funcionó MD5
        if (!passwordValida && trabajador.password_hash && trabajador.password_hash.startsWith('$2b$')) {
            passwordValida = await bcrypt.compare(password, trabajador.password_hash);
            if (passwordValida) console.log('✅ Login exitoso con bcrypt');
        }
        
        // Probar contraseña temporal 1234
        if (!passwordValida && password === '1234') {
            passwordValida = true;
            console.log('⚠️ Login con contraseña temporal 1234');
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
        
        console.log('❌ Contraseña incorrecta');
        res.status(401).json({ success: false, message: "Contraseña incorrecta" });
    });
});

// ================= RECUPERACIÓN TRABAJADOR =================
app.post('/api/trabajadores/recuperar-password', (req, res) => {
    const { email } = req.body;
    
    if (!email) {
        return res.status(400).json({ success: false, message: 'Ingresa tu correo electrónico' });
    }
    
    db.query(`SELECT Id_Trabajador, NombreCompleto, email FROM trabajadores WHERE email = ? AND Activo = 1`, [email], (err, results) => {
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en el servidor' });
        }
        
        if (results.length === 0) {
            return res.json({ success: false, message: 'No existe una cuenta activa con ese correo electrónico' });
        }
        
        const nuevaPassword = Math.random().toString(36).slice(-6);
        const md5pass = crypto.createHash('md5').update(nuevaPassword).digest('hex');
        
        db.query(`UPDATE trabajadores SET password_hash = ?, debe_cambiar_password = 1 WHERE Id_Trabajador = ?`, [md5pass, results[0].Id_Trabajador], (err) => {
            if (err) {
                return res.status(500).json({ success: false, message: 'Error actualizando contraseña' });
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

// ================= VERIFICAR SESIÓN =================
app.get('/api/verificar-sesion', (req, res) => {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ autenticado: false });
    
    jwt.verify(token, SECRET_KEY, (err, decoded) => {
        if (err) return res.status(403).json({ autenticado: false });
        res.json({ autenticado: true, usuario: decoded });
    });
});
// ================= SISTEMA QR PARA VENDEDORES (UN SOLO USO) =================

function generarCodigoUnico(idVendedor) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10).toUpperCase();
    const hash = crypto.createHash('md5').update(`${idVendedor}${timestamp}${random}`).digest('hex').substring(0, 8);
    return `CHP${idVendedor}${timestamp}${hash}`;
}

function crearTablaQRVendedores() {
    db.query(`
        CREATE TABLE IF NOT EXISTS qr_vendedores (
            id INT AUTO_INCREMENT PRIMARY KEY,
            codigo VARCHAR(100) NOT NULL UNIQUE,
            id_vendedor INT NOT NULL,
            nombre_vendedor VARCHAR(100),
            generado_en DATETIME DEFAULT NOW(),
            usado TINYINT DEFAULT 0,
            FOREIGN KEY (id_vendedor) REFERENCES trabajadores(Id_Trabajador)
        )
    `);
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
        
        // Marcar todos los QR anteriores como usados
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id_vendedor = ? AND usado = 0`, [id_vendedor], (err) => {
            if (err) console.error('Error actualizando QR anteriores:', err);
            
            db.query(`
                INSERT INTO qr_vendedores (codigo, id_vendedor, nombre_vendedor, usado) 
                VALUES (?, ?, ?, 0)
            `, [codigo, id_vendedor, nombreVendedor], (err2) => {
                if (err2) {
                    return res.status(500).json({ success: false, message: 'Error guardando QR: ' + err2.message });
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

// Endpoint para validar QR (para la caja)
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
        
        // Marcar como usado
        db.query(`UPDATE qr_vendedores SET usado = 1 WHERE id = ?`, [qr.id]);
        
        res.json({
            valido: true,
            id_vendedor: qr.id_vendedor,
            nombre_vendedor: qr.NombreCompleto
        });
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
        if (err) {
            return res.status(500).json({ success: false, message: 'Error en servidor' });
        }
        
        if (results.length === 0) {
            return res.status(404).json({ success: false, message: 'Vendedor no encontrado' });
        }
        
        const nombreVendedor = results[0].NombreCompleto;
        
        db.query(`
            INSERT INTO qr_vendedores (codigo, id_vendedor, nombre_vendedor, expira_en, generado_desde_app) 
            VALUES (?, ?, ?, ?, 1)
        `, [codigo, id_vendedor, nombreVendedor, expiraEn], (err2) => {
            if (err2) {
                return res.status(500).json({ success: false, message: 'Error guardando QR: ' + err2.message });
            }
            
            res.json({
                success: true,
                codigo: codigo,
                expira: expiraEn,
                vendedor: nombreVendedor
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
        if (err) {
            console.error('Error generando QR:', err);
            return res.status(500).json({ success: false, message: 'Error generando QR' });
        }
        
        const qrBase64 = qrBuffer.toString('base64');
        const qrImageSrc = `data:image/png;base64,${qrBase64}`;
        
        console.log('📧 QR generado para:', email);
        console.log('📱 Código:', codigo);
        
        res.json({ 
            success: true, 
            message: 'QR generado (simulado). En Railway el envío de correos está deshabilitado.',
            qrCode: qrImageSrc
        });
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

// ================= CATEGORÍAS =================
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

// ================= ESTADÍSTICAS =================
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
    db.query(`
        SELECT p.Nombre, SUM(o.CantidadVendida) as cantidad
        FROM orden o
        JOIN producto p ON o.Id_Producto = p.Id_Producto
        GROUP BY p.Id_Producto
        ORDER BY cantidad DESC
        LIMIT 5
    `, (err, results) => {
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
// ================= PUNTOS POR VENDEDOR INDIVIDUAL =================
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
            console.error('Error en /api/puntos-vendedor:', err);
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
        
        res.json({
            success: true,
            ...results[0]
        });
    });
});
// ================= RUTAS PRINCIPALES =================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Chepita corriendo en puerto ${PORT}`);
    console.log(`📌 Login trabajador: usa nombre_usuario o email`);
    console.log(`📌 Contraseña temporal por defecto: 1234`);
});